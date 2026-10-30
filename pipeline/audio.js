/**
 * Аудио: загрузка записей → транскрипция (Whisper) → суммаризация (chat).
 * На диске: audio/{projectId}/meta.json + files/{itemId}.{ext}
 * В Docker — AUDIO_DIR=/data/audio (том).
 *
 * Транскрипция: POST {base}/audio/transcriptions (multipart), AITUNNEL.
 * Суммаризация: POST {base}/chat/completions по тексту транскрипта.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveDictRoot } from './dict.js';
import { recordProviderSpend, usageCostRub, roundMoney, normalizeProviderUsage } from './provider_billing.js';

const PROJECT_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ITEM_RE = /^[a-zA-Z0-9_-]{8,40}$/;
const MAX_PROJECTS = 200;
const MAX_ITEMS = 2_000;
const MAX_FILE_BYTES = Number(process.env.AUDIO_MAX_BYTES || 25 * 1024 * 1024);
const MAX_BATCH_BYTES = Number(process.env.AUDIO_BATCH_BYTES || 64 * 1024 * 1024);
const MAX_BATCH_FILES = Number(process.env.AUDIO_BATCH_FILES || 20);

const MIME_EXT = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
};

const EXT_MIME = {
  mp3: 'audio/mpeg',
  mpga: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  webm: 'audio/webm',
  mpeg: 'audio/mpeg',
};

export const AUDIO_LIMITS = {
  MAX_PROJECTS,
  MAX_ITEMS,
  MAX_FILE_BYTES,
  MAX_BATCH_BYTES,
  MAX_BATCH_FILES,
};

export const TRANSCRIBE_MODELS = [
  { id: 'whisper-1', name: 'Whisper 1' },
  { id: 'gpt-4o-transcribe', name: 'GPT-4o Transcribe' },
  { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe' },
];

export const SUMMARY_STYLES = ['brief', 'bullets', 'actions', 'meeting'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function audioDir(root) {
  if (process.env.AUDIO_DIR) return process.env.AUDIO_DIR;
  const settings = process.env.SETTINGS_PATH;
  if (settings && (settings === '/data/config.json' || settings.startsWith('/data/'))) {
    return '/data/audio';
  }
  return path.join(resolveDictRoot(root), 'audio');
}

export function bootstrapAudioDir(root) {
  const dest = audioDir(root);
  try {
    fs.mkdirSync(dest, { recursive: true });
  } catch (e) {
    throw new Error(
      `не удалось создать каталог аудио «${dest}»: ${e.message}. `
      + 'В Docker задайте AUDIO_DIR=/data/audio.',
    );
  }
  return dest;
}

function projectDir(projectId, root) {
  return path.join(audioDir(root), projectId);
}

function metaPath(projectId, root) {
  return path.join(projectDir(projectId, root), 'meta.json');
}

function filesDir(projectId, root) {
  return path.join(projectDir(projectId, root), 'files');
}

function assertProjectId(id) {
  if (!PROJECT_RE.test(String(id || ''))) throw httpError(400, 'Некорректный id проекта');
  return String(id);
}

function assertItemId(id) {
  if (!ITEM_RE.test(String(id || ''))) throw httpError(400, 'Некорректный id записи');
  return String(id);
}

function newId(prefix = '') {
  return `${prefix}${crypto.randomBytes(8).toString('hex')}`;
}

function blankProject(id, name = '') {
  const now = Date.now();
  return {
    id,
    name: String(name || id).trim() || id,
    created_at: now,
    updated_at: now,
    transcribe_model: 'whisper-1',
    summary_model: null,
    language: 'ru',
    summary_style: 'meeting',
    items: [],
  };
}

function readMeta(projectId, root) {
  const file = metaPath(projectId, root);
  if (!fs.existsSync(file)) throw httpError(404, 'Проект не найден');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
      throw new Error('битый meta.json');
    }
    return raw;
  } catch (e) {
    if (e.status) throw e;
    throw httpError(500, `не удалось прочитать проект: ${e.message}`);
  }
}

function writeMeta(project, root) {
  const id = assertProjectId(project.id);
  fs.mkdirSync(filesDir(id, root), { recursive: true });
  project.updated_at = Date.now();
  const tmp = `${metaPath(id, root)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(project, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, metaPath(id, root));
  return project;
}

function publicItem(item) {
  return {
    id: item.id,
    filename: item.filename,
    mime: item.mime,
    bytes: item.bytes,
    has_file: Boolean(item.stored),
    status: item.status || 'uploaded',
    language: item.language || null,
    duration_sec: item.duration_sec ?? null,
    transcript: item.transcript || null,
    summary: item.summary || null,
    summary_style: item.summary_style || null,
    transcribe_model: item.transcribe_model || null,
    summary_model: item.summary_model || null,
    error: item.error || null,
    usage: item.usage || null,
    processed_at: item.processed_at || null,
    created_at: item.created_at,
  };
}

function publicProject(meta) {
  return {
    id: meta.id,
    name: meta.name,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
    transcribe_model: meta.transcribe_model || 'whisper-1',
    summary_model: meta.summary_model || null,
    language: meta.language || 'ru',
    summary_style: meta.summary_style || 'meeting',
    items: (meta.items || []).map(publicItem),
  };
}

export function listProjects(root) {
  bootstrapAudioDir(root);
  const dir = audioDir(root);
  const names = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && PROJECT_RE.test(d.name))
    .map(d => d.name)
    .sort((a, b) => b.localeCompare(a));

  return names.slice(0, MAX_PROJECTS).map((id) => {
    try {
      const meta = readMeta(id, root);
      const done = meta.items.filter(i => i.status === 'done').length;
      const errors = meta.items.filter(i => i.status === 'error').length;
      const bytes = meta.items.reduce((s, i) => s + (Number(i.bytes) || 0), 0);
      return {
        id: meta.id,
        name: meta.name,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        items: meta.items.length,
        done,
        errors,
        pending: meta.items.length - done - errors,
        bytes,
        language: meta.language || 'ru',
        summary_style: meta.summary_style || 'meeting',
      };
    } catch {
      return { id, name: id, items: 0, done: 0, errors: 0, pending: 0, bytes: 0, broken: true };
    }
  });
}

export function createProject(name, opts = {}, root) {
  bootstrapAudioDir(root);
  if (listProjects(root).length >= MAX_PROJECTS) {
    throw httpError(400, `Лимит проектов: ${MAX_PROJECTS}`);
  }
  const id = newId('au');
  const project = blankProject(id, name);
  if (opts.language) project.language = String(opts.language).slice(0, 8);
  if (opts.summary_style && SUMMARY_STYLES.includes(opts.summary_style)) {
    project.summary_style = opts.summary_style;
  }
  if (opts.transcribe_model) project.transcribe_model = String(opts.transcribe_model).slice(0, 80);
  if (opts.summary_model) project.summary_model = String(opts.summary_model).slice(0, 120);
  writeMeta(project, root);
  return publicProject(project);
}

export function getProject(projectId, root) {
  return publicProject(readMeta(assertProjectId(projectId), root));
}

export function patchProject(projectId, patch = {}, root) {
  const meta = readMeta(assertProjectId(projectId), root);
  if (patch.name != null) {
    const label = String(patch.name || '').trim();
    if (!label) throw httpError(400, 'Укажите название проекта');
    meta.name = label.slice(0, 120);
  }
  if (patch.language != null) meta.language = String(patch.language || 'ru').slice(0, 8);
  if (patch.summary_style != null) {
    if (!SUMMARY_STYLES.includes(patch.summary_style)) {
      throw httpError(400, `Стиль: ${SUMMARY_STYLES.join(', ')}`);
    }
    meta.summary_style = patch.summary_style;
  }
  if (patch.transcribe_model != null) {
    meta.transcribe_model = String(patch.transcribe_model || 'whisper-1').slice(0, 80);
  }
  if ('summary_model' in patch) {
    meta.summary_model = patch.summary_model
      ? String(patch.summary_model).slice(0, 120)
      : null;
  }
  writeMeta(meta, root);
  return publicProject(meta);
}

export function deleteProject(projectId, root) {
  const id = assertProjectId(projectId);
  const dir = projectDir(id, root);
  if (!fs.existsSync(dir)) throw httpError(404, 'Проект не найден');
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, id };
}

function sniffAudioMime(buf, filename = '') {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    return 'audio/wav';
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'audio/mpeg'; // ID3
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.length >= 8 && buf.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === '\x1aEߣ') return 'audio/webm'; // EBML
  const ext = String(filename).split('.').pop()?.toLowerCase();
  if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
  return null;
}

function decodeDataUrlOrBase64(raw) {
  const s = String(raw || '');
  const m = s.match(/^data:([^;]+);base64,(.+)$/i);
  if (m) return { mimeHint: m[1].toLowerCase(), buf: Buffer.from(m[2], 'base64') };
  return { mimeHint: null, buf: Buffer.from(s.replace(/\s+/g, ''), 'base64') };
}

export function uploadAudio(projectId, files, root) {
  const meta = readMeta(assertProjectId(projectId), root);
  if (!Array.isArray(files) || !files.length) throw httpError(400, 'Нет файлов');
  if (files.length > MAX_BATCH_FILES) throw httpError(400, `За раз не больше ${MAX_BATCH_FILES} файлов`);

  let batchBytes = 0;
  const added = [];
  const errors = [];

  for (const file of files) {
    try {
      if (meta.items.length + added.length >= MAX_ITEMS) {
        throw new Error(`лимит записей в проекте: ${MAX_ITEMS}`);
      }
      const name = String(file?.name || file?.filename || 'audio').slice(0, 200);
      const { mimeHint, buf } = decodeDataUrlOrBase64(file?.data || file?.content || '');
      if (!buf.length) throw new Error('пустой файл');
      if (buf.length > MAX_FILE_BYTES) throw new Error(`больше ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ`);
      batchBytes += buf.length;
      if (batchBytes > MAX_BATCH_BYTES) throw new Error('пакет слишком большой');

      let mime = sniffAudioMime(buf, name);
      if (!mime && mimeHint && MIME_EXT[mimeHint]) mime = mimeHint;
      if (!mime && mimeHint?.startsWith('audio/')) mime = mimeHint;
      if (!mime) throw new Error('неизвестный аудиоформат (mp3/wav/flac/m4a/ogg/webm)');

      const ext = MIME_EXT[mime] || String(name).split('.').pop()?.toLowerCase() || 'bin';
      const id = newId('c');
      const stored = `${id}.${ext}`;
      fs.mkdirSync(filesDir(meta.id, root), { recursive: true });
      fs.writeFileSync(path.join(filesDir(meta.id, root), stored), buf);

      const item = {
        id,
        filename: name,
        mime,
        bytes: buf.length,
        stored,
        status: 'uploaded',
        created_at: Date.now(),
      };
      meta.items.push(item);
      added.push(publicItem(item));
    } catch (e) {
      errors.push({ name: file?.name || '?', error: e.message });
    }
  }

  if (added.length) writeMeta(meta, root);
  return { added, errors, project: publicProject(meta) };
}

export function deleteAudioItem(projectId, itemId, root) {
  const meta = readMeta(assertProjectId(projectId), root);
  const id = assertItemId(itemId);
  const idx = meta.items.findIndex(i => i.id === id);
  if (idx < 0) throw httpError(404, 'Запись не найдена');
  const [item] = meta.items.splice(idx, 1);
  if (item.stored) {
    try { fs.unlinkSync(path.join(filesDir(meta.id, root), item.stored)); } catch { /* */ }
  }
  writeMeta(meta, root);
  return { ok: true, id, project: publicProject(meta) };
}

export function patchAudioItem(projectId, itemId, patch = {}, root) {
  const meta = readMeta(assertProjectId(projectId), root);
  const item = meta.items.find(i => i.id === assertItemId(itemId));
  if (!item) throw httpError(404, 'Запись не найдена');
  if (patch.transcript != null) item.transcript = String(patch.transcript).slice(0, 500_000);
  if (patch.summary != null) item.summary = String(patch.summary).slice(0, 100_000);
  writeMeta(meta, root);
  return publicItem(item);
}

export async function readAudioFile(projectId, itemId, root) {
  const meta = readMeta(assertProjectId(projectId), root);
  const item = meta.items.find(i => i.id === assertItemId(itemId));
  if (!item) throw httpError(404, 'Запись не найдена');
  if (!item.stored) throw httpError(404, 'Файл не загружен');
  const file = path.join(filesDir(meta.id, root), item.stored);
  if (!fs.existsSync(file)) throw httpError(404, 'Файл на диске не найден');
  const buf = fs.readFileSync(file);
  return { item, mime: item.mime || 'application/octet-stream', buf, filename: item.filename || item.stored };
}

export function sumAudioSpend(root) {
  bootstrapAudioDir(root);
  let sum = 0;
  for (const project of listProjects(root)) {
    if (project.broken) continue;
    try {
      const meta = readMeta(project.id, root);
      for (const item of meta.items || []) {
        const cost = usageCostRub(item.usage);
        if (typeof cost === 'number') sum += cost;
      }
    } catch { /* */ }
  }
  return roundMoney(sum);
}

/** Multipart как Buffer — providerFetch/fetchHttp не едят FormData. */
export function buildMultipart(fields, file) {
  const boundary = `----OgranAudio${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields || {})) {
    if (value == null || value === '') continue;
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8',
    ));
  }
  const filename = String(file.filename || 'audio.bin').replace(/"/g, '');
  const mime = file.mime || 'application/octet-stream';
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + `Content-Type: ${mime}\r\n\r\n`,
    'utf8',
  ));
  chunks.push(file.buf);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Доменные правила к любому стилю суммаризации.
 * Сюда стоит добавить то, что важно именно вам (товары, клиенты, тон).
 *
 * TODO(user): реализуйте 5–10 строк ниже — это сильнее всего влияет на качество резюме.
 * Примеры: «всегда выделяй названия товаров и артикулы», «не упоминай цены»,
 * «если говорили о сроках поставки — вынеси их отдельно».
 */
export function buildSummaryDomainRules(_style = 'meeting') {
  // --- ваш код ---
  return '';
}

/** Системный промпт суммаризации = базовый стиль + ваши доменные правила. */
export function buildSummarySystemPrompt(style = 'meeting') {
  const base = 'Ты помощник по разбору аудиозаписей. Пиши по-русски, ясно и по делу. Не выдумывай факты, которых нет в тексте.';
  let body;
  switch (style) {
    case 'brief':
      body = `${base}\nСделай краткое резюме на 5–8 предложений.`;
      break;
    case 'bullets':
      body = `${base}\nВыдели ключевые тезисы маркированным списком (8–15 пунктов).`;
      break;
    case 'actions':
      body = `${base}\nВыпиши решения и задачи. Формат:\n## Решения\n- …\n## Задачи\n- [кто?] что сделать — срок (если назван)`;
      break;
    case 'meeting':
    default:
      body = `${base}\nОформи протокол встречи:\n## Темы\n## Решения\n## Задачи\n## Открытые вопросы\nЕсли раздела нет в записи — напиши «не обсуждалось».`;
  }
  const extra = String(buildSummaryDomainRules(style) || '').trim();
  return extra ? `${body}\n\nДополнительно:\n${extra}` : body;
}

async function callTranscription({
  buf, filename, mime, model, language, apiKey, baseUrl, headers = {}, fetchImpl = fetch, onNote = () => {},
}) {
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}/audio/transcriptions`;
  const fields = {
    model: String(model || 'whisper-1'),
    response_format: 'verbose_json',
  };
  if (language) fields.language = String(language).slice(0, 8);
  const { body, contentType } = buildMultipart(fields, { buf, filename, mime });
  onNote(`транскрипция ${model}…`);

  const hdrs = { ...(headers || {}) };
  // Не протаскиваем чужой Content-Type: нужен multipart с boundary.
  for (const k of Object.keys(hdrs)) {
    if (k.toLowerCase() === 'content-type') delete hdrs[k];
  }
  hdrs['Content-Type'] = contentType;
  if (apiKey && !Object.keys(hdrs).some(k => k.toLowerCase() === 'authorization')) {
    hdrs.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: hdrs,
    body,
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || data?.message
      || `транскрипция HTTP ${res.status}: ${text.slice(0, 220)}`;
    throw Object.assign(new Error(String(msg)), { status: res.status >= 400 ? res.status : 502, raw: text.slice(0, 800) });
  }
  const transcript = String(data?.text || data?.transcript || '').trim();
  if (!transcript) throw Object.assign(new Error('пустой транскрипт'), { raw: text.slice(0, 400) });
  const usage = normalizeProviderUsage(data?.usage || {}, { currency: 'RUB' });
  const duration = typeof data?.duration === 'number' ? data.duration
    : (typeof data?.usage?.seconds === 'number' ? data.usage.seconds : null);
  return { transcript, duration_sec: duration, usage, raw: data };
}

async function callSummary({
  transcript, model, style, chatUrl, headers = {}, apiKey, fetchImpl = fetch, onNote = () => {},
}) {
  onNote(`суммаризация ${model}…`);
  const body = {
    model,
    temperature: 0.2,
    max_tokens: 2500,
    messages: [
      { role: 'system', content: buildSummarySystemPrompt(style) },
      {
        role: 'user',
        content: `Транскрипт аудиозаписи:\n\n${String(transcript).slice(0, 120_000)}`,
      },
    ],
  };
  const hdrs = { ...(headers || {}), 'Content-Type': 'application/json' };
  if (apiKey && !Object.keys(hdrs).some(k => k.toLowerCase() === 'authorization')) {
    hdrs.Authorization = `Bearer ${apiKey}`;
  }
  const res = await fetchImpl(chatUrl, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || data?.message
      || `суммаризация HTTP ${res.status}: ${text.slice(0, 220)}`;
    throw Object.assign(new Error(String(msg)), { status: res.status >= 400 ? res.status : 502, raw: text.slice(0, 800) });
  }
  const summary = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!summary) throw Object.assign(new Error('пустая суммаризация'), { raw: text.slice(0, 400) });
  const usage = normalizeProviderUsage(data?.usage || {}, { currency: 'RUB' });
  return { summary, usage };
}

function mergeUsage(a, b) {
  const x = normalizeProviderUsage(a || {}, { currency: 'RUB' });
  const y = normalizeProviderUsage(b || {}, { currency: 'RUB' });
  const cost = (typeof x.cost_rub === 'number' ? x.cost_rub : 0)
    + (typeof y.cost_rub === 'number' ? y.cost_rub : 0);
  return {
    prompt_tokens: (x.prompt_tokens || 0) + (y.prompt_tokens || 0),
    completion_tokens: (x.completion_tokens || 0) + (y.completion_tokens || 0),
    total_tokens: (x.total_tokens || 0) + (y.total_tokens || 0),
    cost_rub: cost || null,
    cost: cost || null,
    currency: 'RUB',
    balance: y.balance ?? x.balance ?? null,
    transcribe: x,
    summary: y,
  };
}

export function applyProcessResult(projectId, itemId, result, root) {
  const meta = readMeta(assertProjectId(projectId), root);
  const item = meta.items.find(i => i.id === assertItemId(itemId));
  if (!item) throw httpError(404, 'Запись не найдена');
  if (result?.error) {
    item.status = 'error';
    item.error = String(result.error).slice(0, 800);
  } else {
    item.status = 'done';
    item.error = null;
    item.transcript = result.transcript || item.transcript;
    item.summary = result.summary || item.summary;
    item.duration_sec = result.duration_sec ?? item.duration_sec;
    item.language = result.language || item.language;
    item.summary_style = result.summary_style || item.summary_style;
    item.transcribe_model = result.transcribe_model || item.transcribe_model;
    item.summary_model = result.summary_model || item.summary_model;
    item.usage = result.usage || item.usage;
    item.processed_at = Date.now();
  }
  writeMeta(meta, root);
  return publicItem(item);
}

/**
 * Один файл: транскрипция + суммаризация.
 * summarize=false — только текст (если суммаризация не нужна).
 */
export async function processAudioItem(file, {
  transcribeModel = 'whisper-1',
  summaryModel,
  language = 'ru',
  summaryStyle = 'meeting',
  summarize = true,
  apiKey = null,
  baseUrl,
  chatUrl,
  headers = {},
  fetchImpl = fetch,
  onNote = () => {},
  root = null,
} = {}) {
  if (!summaryModel && summarize) {
    throw httpError(400, 'Нужна модель для суммаризации');
  }
  const tr = await callTranscription({
    buf: file.buf,
    filename: file.filename,
    mime: file.mime,
    model: transcribeModel,
    language,
    apiKey,
    baseUrl,
    headers,
    fetchImpl,
    onNote,
  });

  let summary = null;
  let sumUsage = null;
  if (summarize) {
    const sm = await callSummary({
      transcript: tr.transcript,
      model: summaryModel,
      style: summaryStyle,
      chatUrl,
      headers,
      apiKey,
      fetchImpl,
      onNote,
    });
    summary = sm.summary;
    sumUsage = sm.usage;
  }

  const usage = mergeUsage(tr.usage, sumUsage);
  if (root) {
    try { recordProviderSpend('aitunnel', usage, root); } catch { /* */ }
  }

  return {
    transcript: tr.transcript,
    summary,
    duration_sec: tr.duration_sec,
    language,
    summary_style: summaryStyle,
    transcribe_model: transcribeModel,
    summary_model: summaryModel || null,
    usage,
  };
}
