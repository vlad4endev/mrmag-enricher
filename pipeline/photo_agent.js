/**
 * Vision-агент: описание фото для витрины и ML-разметки.
 * По умолчанию — только картинка. Если фото привязано к дампу
 * (dump_category + product_id), подмешиваем карточку для сверки.
 */

import { RateLimiter } from '../lib.js';
import { getDump } from './dumps.js';
import { normalizeProviderUsage } from './provider_billing.js';

export const PHOTO_PROMPT_PLACEHOLDERS = [
  { key: '{{filename}}', note: 'имя файла изображения' },
  { key: '{{product_id}}', note: 'id товара, если фото привязано к дампу' },
  { key: '{{dump_category}}', note: 'id раздела дампа при привязке' },
  { key: '{{dump_name}}', note: 'название из дампа (только при привязке)' },
  { key: '{{dump_annotation}}', note: 'annotation из дампа (только при привязке)' },
];

export function defaultPhotoSystemPrompt() {
  return `Ты — агент описания товарных фото для интернет-магазина бытовой техники и электроники (RU).
По изображению верни ТОЛЬКО JSON-объект:
{
  "caption": "короткая подпись 8–18 слов для ML/поиска (сцена целиком, без списка объектов)",
  "on_image": "перечень того, что видно на фото, через запятую: объекты, фон, детали. Пример: «встраиваемая вытяжка, чёрный корпус, панель управления, вытяжной зонт, кухонный фартук». 5–14 элементов, без глаголов и без полного предложения",
  "description": "2–4 предложения: ракурс, цвет, комплектация, расположение объектов, заметные детали. Не повторяй on_image дословно — это развёрнутое описание сцены. Без выдуманных характеристик, которых не видно.",
  "alt": "alt-текст для a11y, до 120 символов",
  "tags": ["тег1","тег2", "... до 12 штук — поисковые ярлыки, короче чем on_image"],
  "attributes": {
    "view": "front|side|angle|detail|packshot|lifestyle|other",
    "color": "если видно",
    "product_type": "тип товара если узнаваем",
    "brand_visible": true/false,
    "text_on_image": "коротко или пусто"
  },
  "warnings": ["если качество плохое / водяной знак / коллаж / не товар"]
}
Правила: только факты с фото; не выдумывай объём/мощность/габариты; язык русский; JSON без markdown.
on_image — инвентарь видимого (существительные/короткие словосочетания через запятую). description — связный текст.
Если в запросе передан dump — не противоречь известным полям, но не копируй текст дампа слепо и не выдумывай то, чего нет на фото.
Без dump опирайся только на изображение.`;
}

/** Пустой шаблон → встроенный. */
export function resolvePhotoSystemPrompt(template, vars = {}) {
  const raw = String(template || '').trim();
  const base = raw || defaultPhotoSystemPrompt();
  return base
    .replaceAll('{{filename}}', String(vars.filename ?? ''))
    .replaceAll('{{product_id}}', String(vars.product_id ?? ''))
    .replaceAll('{{dump_category}}', String(vars.dump_category ?? ''))
    .replaceAll('{{dump_name}}', String(vars.dump_name ?? ''))
    .replaceAll('{{dump_annotation}}', String(vars.dump_annotation ?? ''));
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** content у OpenAI-compatible шлюзов бывает строкой или массивом частей (Gemini). */
export function extractMessageContent(message) {
  const c = message?.content;
  if (c == null) {
    if (typeof message?.text === 'string') return message.text;
    if (typeof message?.refusal === 'string') return message.refusal;
    return '';
  }
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof c === 'object' && typeof c.text === 'string') return c.text;
  return String(c);
}

function parseJsonContent(content) {
  let text = String(content || '').trim();
  // Иногда шлюз кладёт уже-объект / двойной JSON-string
  if (text.startsWith('"') && text.endsWith('"')) {
    try { text = JSON.parse(text); } catch { /* keep */ }
    text = String(text || '').trim();
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Ответ модели без JSON-объекта');
  return JSON.parse(raw.slice(start, end + 1));
}

function firstNonEmpty(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

/** Модели иногда кладут поля во вложенный result/data или на русском. */
function unwrapVisionRoot(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const hasCore = (o) => o && (
    firstNonEmpty(o, [
      'caption', 'Caption', 'подпись', 'title', 'description', 'Description', 'описание', 'text', 'alt',
      'on_image', 'onImage', 'objects', 'scene', 'на_картинке',
    ])
  );
  if (hasCore(parsed)) return parsed;
  for (const k of ['result', 'data', 'output', 'response', 'photo', 'image', 'fields', 'vision']) {
    const inner = parsed[k];
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && hasCore(inner)) return inner;
  }
  return parsed;
}

function normalizeOnImage(root) {
  const fromStr = firstNonEmpty(root, [
    'on_image', 'onImage', 'OnImage', 'ON_IMAGE',
    'scene', 'Scene', 'contents', 'content_list',
    'на_картинке', 'на картинке', 'что_на_фото', 'objects_text',
  ]);
  if (fromStr) {
    return fromStr
      .replace(/^на\s+картинке\s*[:—–-]?\s*/i, '')
      .replace(/\s*,\s*/g, ', ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000);
  }
  const arr = Array.isArray(root.objects) ? root.objects
    : (Array.isArray(root.items_on_image) ? root.items_on_image
      : (Array.isArray(root.scene_objects) ? root.scene_objects
        : (Array.isArray(root.visible) ? root.visible : null)));
  if (arr?.length) {
    return [...new Set(arr.map(t => String(t).trim()).filter(Boolean))]
      .slice(0, 24)
      .join(', ')
      .slice(0, 2000);
  }
  return '';
}

function normalizeVision(parsed) {
  const root = unwrapVisionRoot(parsed) || {};
  const attributesRaw = root.attributes && typeof root.attributes === 'object'
    ? root.attributes
    : (root.attrs && typeof root.attrs === 'object' ? root.attrs : {});
  const attributes = Object.fromEntries(
    Object.entries(attributesRaw)
      .filter(([, v]) => v != null && String(v).trim() !== '')
      .map(([k, v]) => [String(k).slice(0, 40), typeof v === 'boolean' ? v : String(v).slice(0, 200)]),
  );
  const tagsSrc = Array.isArray(root.tags) ? root.tags
    : (Array.isArray(root.labels) ? root.labels
      : (Array.isArray(root.keywords) ? root.keywords : []));
  const warningsSrc = Array.isArray(root.warnings) ? root.warnings
    : (Array.isArray(root.notes) ? root.notes : []);
  const tags = [...new Set(tagsSrc.map(t => String(t).trim()).filter(Boolean))].slice(0, 40);
  let on_image = normalizeOnImage(root);
  // Fallback: если модель не дала on_image — собрать из тегов (лучше, чем пусто)
  if (!on_image && tags.length) {
    on_image = tags.slice(0, 14).join(', ');
  }
  return {
    caption: firstNonEmpty(root, [
      'caption', 'Caption', 'CAPTION', 'title', 'Title', 'подпись', 'заголовок', 'summary', 'short_description',
    ]).slice(0, 1000),
    on_image: on_image.slice(0, 2000),
    description: firstNonEmpty(root, [
      'description', 'Description', 'DESCRIPTION', 'text', 'Text', 'описание',
      'full_description', 'long_description', 'body', 'details',
    ]).slice(0, 8000),
    alt: firstNonEmpty(root, ['alt', 'Alt', 'alt_text', 'altText', 'альт']).slice(0, 500),
    tags,
    attributes,
    warnings: warningsSrc.map(w => String(w).trim()).filter(Boolean).slice(0, 20),
  };
}

/** Строгая схема для AITUNNEL json_schema — меньше пустых/чужих ключей у Gemini. */
export const PHOTO_RESPONSE_SCHEMA = {
  name: 'photo_description',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['caption', 'on_image', 'description', 'alt', 'tags', 'attributes', 'warnings'],
    properties: {
      caption: { type: 'string', description: 'Короткая подпись 8–18 слов' },
      on_image: {
        type: 'string',
        description: 'Перечень видимого через запятую: объекты, фон, детали (5–14 элементов)',
      },
      description: { type: 'string', description: '2–4 предложения: развёрнутое описание сцены' },
      alt: { type: 'string', description: 'alt до 120 символов' },
      tags: { type: 'array', items: { type: 'string' } },
      attributes: {
        type: 'object',
        additionalProperties: false,
        properties: {
          view: { type: 'string' },
          color: { type: 'string' },
          product_type: { type: 'string' },
          brand_visible: { type: 'boolean' },
          text_on_image: { type: 'string' },
        },
        required: ['view', 'color', 'product_type', 'brand_visible', 'text_on_image'],
      },
      warnings: { type: 'array', items: { type: 'string' } },
    },
  },
};

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
  const blob = `${vision.caption} ${vision.on_image || ''} ${vision.description} ${vision.tags.join(' ')}`.toLowerCase();
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
    task: dump
      ? 'Опиши товар на фото. Передан dump — не противоречь известным полям, но не копируй текст дампа слепо.'
      : (productId
        ? 'Привязка к дампу задана, но товар в дампе не найден — опиши только то, что видно на фото.'
        : 'Опиши только то, что видно на фото. Дамп не привязан.'),
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
 * dump/category подключаются только если фото явно привязано.
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
    maxTokens = 2000,
    category = null,
    root = undefined,
    useDump = false,
    onNote = () => {},
    referer = 'https://mrmag.ru',
    title = 'Ogran Photos',
    systemPrompt = '',
  } = opts;

  if (!model) throw Object.assign(new Error('Не передана модель'), { status: 400 });

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const rate = limiter || new RateLimiter(30);
  const dump = useDump
    ? dumpContext(itemFile.item?.product_id, itemFile.item?.sku, category, root)
    : null;
  if (useDump && !dump) {
    onNote('привязка к дампу: товар не найден — описываем только фото');
  } else if (dump) {
    onNote(`дамп ${category} · id ${dump.id || itemFile.item?.product_id}`);
  }
  const base64 = itemFile.buf.toString('base64');
  const system = resolvePhotoSystemPrompt(systemPrompt, {
    filename: itemFile.item?.filename || '',
    product_id: useDump ? (itemFile.item?.product_id || '') : '',
    dump_category: useDump ? (category || '') : '',
    dump_name: dump?.name || '',
    dump_annotation: dump?.annotation || '',
  });

  await rate.wait(ms => onNote(`rate limit ${ms}ms`));
  onNote('запрос к vision-модели…');

  const messages = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: buildUserParts({
        mime: itemFile.mime,
        base64,
        filename: itemFile.item?.filename,
        productId: useDump ? itemFile.item?.product_id : null,
        sku: useDump ? itemFile.item?.sku : null,
        dump,
      }),
    },
  ];

  const baseBody = {
    model,
    max_tokens: maxTokens,
    temperature: 0.2,
    messages,
  };
  // OpenRouter-only: остальные шлюзы (AITUNNEL и т.п.) могут отвергнуть неизвестное поле.
  if (/openrouter\.ai/i.test(chatUrl)) baseBody.usage = { include: true };

  // Сначала json_schema (AITUNNEL/Gemini), потом мягкий json_object, потом без формата.
  const formatAttempts = [
    { type: 'json_schema', json_schema: PHOTO_RESPONSE_SCHEMA },
    { type: 'json_object' },
    null,
  ];

  async function postOnce(responseFormat) {
    const body = { ...baseBody };
    if (responseFormat) body.response_format = responseFormat;
    const res = await doFetch(chatUrl, {
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
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    return { res, text, data };
  }

  let res;
  let text;
  let data;
  let lastHttpErr = null;
  try {
    for (let i = 0; i < formatAttempts.length; i++) {
      const fmt = formatAttempts[i];
      const out = await postOnce(fmt);
      res = out.res;
      text = out.text;
      data = out.data;
      if (res.ok && !data?.error) {
        if (i > 0) onNote(`vision: ответ без ${i === 1 ? 'json_schema' : 'response_format'}`);
        break;
      }
      const msg = data?.error?.message || `HTTP ${res.status}: ${String(text).slice(0, 180)}`;
      lastHttpErr = Object.assign(new Error(msg), { status: res.status >= 400 ? res.status : 502 });
      // Неподдерживаемый response_format / схема → пробуем следующий вариант
      const retryable = res.status === 400 || res.status === 422
        || /response_format|json_schema|json_object|unsupported|unknown|не поддерж/i.test(msg);
      if (!retryable || i === formatAttempts.length - 1) throw lastHttpErr;
      onNote(`vision: ${msg.slice(0, 80)} → другой формат ответа`);
    }
  } catch (e) {
    if (e?.status) throw e;
    const timed = e.name === 'TimeoutError' || e.cause?.name === 'TimeoutError';
    throw Object.assign(
      new Error(timed ? `таймаут vision ${timeoutMs}ms` : `vision: ${e.message}`),
      { status: 502 },
    );
  }

  if (!res?.ok || data?.error) {
    throw lastHttpErr || Object.assign(new Error('vision HTTP error'), { status: 502 });
  }

  const content = extractMessageContent(data?.choices?.[0]?.message);
  if (!String(content).trim()) {
    const finish = data?.choices?.[0]?.finish_reason || '';
    throw Object.assign(
      new Error(`Пустой ответ vision-модели${finish ? ` (${finish})` : ''}`),
      { status: 502, raw: text?.slice?.(0, 500) },
    );
  }

  let parsed;
  try {
    parsed = parseJsonContent(content);
  } catch (e) {
    throw Object.assign(new Error(`Не разобрали JSON: ${e.message}`), {
      status: 502,
      raw: String(content).slice(0, 800),
    });
  }

  const vision = normalizeVision(parsed);
  if (!vision.caption && !vision.description) {
    // Если модель вернула один длинный текст в неожиданном ключе — подхватим.
    const fallback = firstNonEmpty(unwrapVisionRoot(parsed) || parsed, [
      'content', 'message', 'answer', 'ответ', 'анализ',
    ]);
    if (fallback.length >= 24) {
      vision.description = fallback.slice(0, 8000);
      vision.caption = fallback.slice(0, 120);
      vision.warnings = [...vision.warnings, 'поля caption/description восстановлены из общего текста ответа'];
    }
  }
  if (!vision.caption && !vision.description) {
    throw Object.assign(new Error('Модель не вернула caption/description'), {
      status: 502,
      raw: String(content).slice(0, 800),
    });
  }
  if (!vision.caption && vision.description) {
    vision.caption = vision.description.split(/[.!?…]/)[0].trim().slice(0, 120) || vision.description.slice(0, 80);
  }
  if (!vision.description && vision.caption) {
    vision.description = vision.caption;
  }
  if (!vision.alt) vision.alt = vision.caption.slice(0, 120);
  if (!vision.on_image && vision.tags?.length) {
    vision.on_image = vision.tags.slice(0, 14).join(', ');
  }

  vision.warnings = consistencyLite(vision, dump);

  // AITUNNEL: usage.cost_rub + usage.balance. OpenRouter: usage.cost (USD).
  const usage = normalizeProviderUsage(data.usage, { currency: 'RUB' });

  return {
    ...vision,
    model,
    usage,
    dump_linked: Boolean(dump),
  };
}
