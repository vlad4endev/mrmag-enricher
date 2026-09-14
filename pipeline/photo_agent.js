/**
 * Vision-агент: описание фото для витрины и ML-разметки.
 *
 * 1) multimodal LLM → caption / description / alt / tags / attributes
 * 2) если есть product_id — сверяем с дампом (consistency-lite)
 * 3) предупреждения, если картинка и текст товара расходятся
 */

import { RateLimiter } from '../lib.js';
import { getDump } from './dumps.js';

const SYSTEM = `Ты — агент описания товарных фото для интернет-магазина бытовой техники и электроники (RU).
По изображению верни ТОЛЬКО JSON-объект:
{
  "caption": "короткая подпись 8–18 слов для ML/поиска",
  "description": "2–4 предложения: что на фото, ракурс, цвет, комплектация, заметные детали. Без выдуманных характеристик, которых не видно.",
  "alt": "alt-текст для a11y, до 120 символов",
  "tags": ["тег1","тег2", "... до 12 штук"],
  "attributes": {
    "view": "front|side|angle|detail|packshot|lifestyle|other",
    "color": "если видно",
    "product_type": "тип товара если узнаваем",
    "brand_visible": true/false,
    "text_on_image": "коротко или пусто"
  },
  "warnings": ["если качество плохое / водяной знак / коллаж / не товар"]
}
Правила: только факты с фото; не выдумывай объём/мощность/габариты; язык русский; JSON без markdown.`;

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJsonContent(content) {
  const text = String(content || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Ответ модели без JSON-объекта');
  return JSON.parse(raw.slice(start, end + 1));
}

function normalizeVision(parsed) {
  const attributes = parsed?.attributes && typeof parsed.attributes === 'object'
    ? Object.fromEntries(
      Object.entries(parsed.attributes)
        .filter(([, v]) => v != null && String(v).trim() !== '')
        .map(([k, v]) => [String(k).slice(0, 40), typeof v === 'boolean' ? v : String(v).slice(0, 200)]),
    )
    : {};
  return {
    caption: String(parsed?.caption || '').trim().slice(0, 1000),
    description: String(parsed?.description || '').trim().slice(0, 8000),
    alt: String(parsed?.alt || '').trim().slice(0, 500),
    tags: Array.isArray(parsed?.tags)
      ? [...new Set(parsed.tags.map(t => String(t).trim()).filter(Boolean))].slice(0, 40)
      : [],
    attributes,
    warnings: Array.isArray(parsed?.warnings)
      ? parsed.warnings.map(w => String(w).trim()).filter(Boolean).slice(0, 20)
      : [],
  };
}

function dumpContext(productId, sku, category, root) {
  const key = String(productId || sku || '').trim();
  const catId = String(category || '').trim();
  if (!key || !/^\d+$/.test(catId)) return null;
  try {
    const { products } = getDump(catId, root);
    const hit = (products || []).find((p) => {
      const id = p?.id != null ? String(p.id).trim() : '';
      const pSku = p?.sku != null ? String(p.sku).trim() : '';
      return id === key || pSku === key;
    });
    if (!hit) return null;
    return {
      id: hit.id ?? null,
      name: hit.name || '',
      description: stripHtml(hit.description).slice(0, 1200),
      annotation: stripHtml(hit.annotation).slice(0, 800),
    };
  } catch {
    return null;
  }
}

function consistencyLite(vision, dump) {
  const warnings = [...(vision.warnings || [])];
  if (!dump) return warnings;
  const name = String(dump.name || '').toLowerCase();
  const blob = `${vision.caption} ${vision.description} ${vision.tags.join(' ')}`.toLowerCase();
  if (name) {
    const tokens = name.split(/[\s,/|−–—-]+/).filter(t => t.length >= 4).slice(0, 6);
    const hit = tokens.some(t => blob.includes(t));
    if (tokens.length >= 2 && !hit) {
      warnings.push('описание фото слабо пересекается с названием товара из дампа — проверьте привязку');
    }
  }
  return warnings;
}

function buildUserParts({ mime, base64, filename, productId, sku, dump }) {
  const meta = {
    filename: filename || null,
    product_id: productId || null,
    sku: sku || null,
    dump: dump || null,
    task: 'Опиши товар на фото. Если передан dump — не противоречь известным полям, но не копируй слепо текст дампа.',
  };
  return [
    { type: 'text', text: JSON.stringify(meta) },
    {
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${base64}` },
    },
  ];
}

/**
 * Описать одно фото через vision-модель провайдера.
 */
export async function describePhoto(itemFile, opts = {}) {
  const {
    model,
    apiKey,
    chatUrl = 'https://openrouter.ai/api/v1/chat/completions',
    headers: extraHeaders = {},
    fetchImpl = null,
    limiter = null,
    timeoutMs = 90_000,
    maxTokens = 1200,
    category = null,
    root = undefined,
    onNote = () => {},
    referer = 'https://mrmag.ru',
    title = 'Ogran Photos',
  } = opts;

  if (!model) throw Object.assign(new Error('Не передана модель'), { status: 400 });

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const rate = limiter || new RateLimiter(30);
  const dump = dumpContext(itemFile.item?.product_id, itemFile.item?.sku, category, root);
  const base64 = itemFile.buf.toString('base64');

  await rate.wait(ms => onNote(`rate limit ${ms}ms`));
  onNote('запрос к vision-модели…');

  const body = {
    model,
    max_tokens: maxTokens,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: buildUserParts({
          mime: itemFile.mime,
          base64,
          filename: itemFile.item?.filename,
          productId: itemFile.item?.product_id,
          sku: itemFile.item?.sku,
          dump,
        }),
      },
    ],
  };
  // OpenRouter-only: остальные шлюзы (AITUNNEL и т.п.) могут отвергнуть неизвестное поле.
  if (/openrouter\.ai/i.test(chatUrl)) body.usage = { include: true };

  let res;
  let text;
  try {
    res = await doFetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'HTTP-Referer': referer,
        'X-Title': title,
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    const timed = e.name === 'TimeoutError' || e.cause?.name === 'TimeoutError';
    throw Object.assign(
      new Error(timed ? `таймаут vision ${timeoutMs}ms` : `vision: ${e.message}`),
      { status: 502 },
    );
  }

  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok || data?.error) {
    const msg = data?.error?.message || `HTTP ${res.status}: ${String(text).slice(0, 180)}`;
    throw Object.assign(new Error(msg), { status: res.status >= 400 ? res.status : 502 });
  }

  const content = data?.choices?.[0]?.message?.content ?? '';
  if (!String(content).trim()) {
    throw Object.assign(new Error('Пустой ответ vision-модели'), { status: 502 });
  }

  let parsed;
  try {
    parsed = parseJsonContent(content);
  } catch (e) {
    throw Object.assign(new Error(`Не разобрали JSON: ${e.message}`), { status: 502, raw: content });
  }

  const vision = normalizeVision(parsed);
  if (!vision.caption && !vision.description) {
    throw Object.assign(new Error('Модель не вернула caption/description'), { status: 502 });
  }
  vision.warnings = consistencyLite(vision, dump);

  const usage = {
    prompt_tokens: data.usage?.prompt_tokens ?? 0,
    completion_tokens: data.usage?.completion_tokens ?? 0,
    cost: typeof data.usage?.cost === 'number' ? data.usage.cost : null,
  };

  return {
    ...vision,
    model,
    usage,
    dump_linked: Boolean(dump),
  };
}
