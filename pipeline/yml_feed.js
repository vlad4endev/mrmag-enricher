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

/** Заглушки магазинов: есть URL, но описывать нечего — товар пропускаем. */
const PLACEHOLDER_PIC_RE = /(?:^|\/)(?:no[_-]?image|nophoto|no[_-]?photo|placeholder|default[_-]?(?:image|photo|product)|image[_-]?not[_-]?available|pic[_-]?empty)(?:\.[a-z0-9]+)?(?:$|[?#])/i;

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, m => ENT[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(xml, name) {
  // Только прямой потомок: первое вхождение имени на уровне offer (не вложенный <stock><url>).
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
}

/**
 * URL картинки из фида годен для превью/описания: http(s), не заглушка noimage.
 * Прокси не используем — браузер и сервер ходят по ссылке напрямую.
 */
export function isUsablePictureUrl(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (PLACEHOLDER_PIC_RE.test(u)) return false;
  return true;
}

/** Все <picture> оффера (в YML их бывает несколько) → абсолютные URL. */
export function parsePictures(xml, shopUrl = '') {
  const out = [];
  const seen = new Set();
  for (const m of xml.matchAll(/<picture(?:\s[^>]*)?>([\s\S]*?)<\/picture>/gi)) {
    let raw = decode(m[1]);
    if (!raw) continue;
    if (!/^https?:\/\//i.test(raw) && shopUrl) {
      try { raw = new URL(raw, shopUrl).href; } catch { /* оставляем как есть */ }
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** Первая пригодная картинка оффера (не noimage / placeholder). */
export function pickPictureUrl(xml, shopUrl = '') {
  const pics = parsePictures(xml, shopUrl);
  return pics.find(isUsablePictureUrl) || '';
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

export function parseOffer(xml, categories = new Map(), shopUrl = '') {
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
  const pictures = parsePictures(xml, shopUrl);
  const image_url = pictures.find(isUsablePictureUrl) || '';
  return {
    id,
    name: tag(xml, 'name'),
    vendor: tag(xml, 'vendor'),
    vendor_code: tag(xml, 'vendorCode'),
    description: tag(xml, 'description'),
    url: tag(xml, 'url'),
    image_url,
    pictures,
    category_id: categoryId,
    category: categoryPath(categories, categoryId),
    params,
    synonyms: [...new Set(synonyms)].slice(0, 12),
  };
}

/**
 * chunks — любой async/sync iterable строк или Buffer (fetch body, fs.createReadStream).
 * filter(offer) → bool, limit — максимум принятых товаров; после лимита поток не читаем.
 */
export async function parseYml(chunks, { limit = Infinity, offset = 0, filter = null } = {}) {
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let categories = null;
  let shopUrl = '';
  let seen = 0;
  const offers = [];

  for await (const chunk of chunks) {
    buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
    if (!shopUrl) {
      // <shop><name>…</name><url>https://…</url> — база для относительных <picture>
      const shopHead = buf.match(/<shop\b[\s\S]{0,4000}?<url>([\s\S]*?)<\/url>/i);
      if (shopHead) shopUrl = decode(shopHead[1]);
    }
    if (!categories) {
      const end = buf.indexOf('</categories>');
      if (end >= 0) categories = parseCategories(buf.slice(0, end));
      else if (buf.indexOf('<offer ') >= 0 || buf.indexOf('<offer>') >= 0) categories = new Map(); // фид без categories
      else continue;
    }
    let from = 0;
    for (;;) {
      const sOffer = buf.indexOf('<offer ', from);
      const sBare = buf.indexOf('<offer>', from);
      let s = -1;
      if (sOffer < 0) s = sBare;
      else if (sBare < 0) s = sOffer;
      else s = Math.min(sOffer, sBare);
      if (s < 0) break;
      const e = buf.indexOf('</offer>', s);
      if (e < 0) break;
      from = e + 8;
      const offer = parseOffer(buf.slice(s, from), categories, shopUrl);
      // Без реальной картинки описывать нечего — noimage и пустые picture отбрасываем здесь.
      if (!offer.id || !offer.name || !offer.image_url || (filter && !filter(offer))) continue;
      if (seen++ < offset) continue;
      offers.push(offer);
      if (offers.length >= limit) return { offers, categories, shopUrl };
    }
    // оставляем только хвост с недочитанным <offer>
    const tailOffer = buf.lastIndexOf('<offer ');
    const tailBare = buf.lastIndexOf('<offer>');
    const tail = Math.max(tailOffer, tailBare);
    buf = tail >= from ? buf.slice(tail) : buf.slice(from);
  }
  if (!categories) throw new Error('Не похоже на YML: нет <categories>/<offer>');
  return { offers, categories, shopUrl };
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
