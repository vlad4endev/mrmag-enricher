/**
 * Regression: enrichment log / AI trace must carry the actual model call
 * payload (source, system, user, raw, enriched) — not empty «нет данных».
 */
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  enrichProduct, RateLimiter, schemaFor, modelNotCalledDebug, sourceText,
} from './lib.js';
import { createJobStore } from './jobs.js';
import { loadProducts } from './pipeline/dict.js';

const EMPTY = '— нет данных —';

let failed = 0;
const t = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
};

const mkDesc = () => [1, 2, 3, 4].map(i =>
  (`Абзац ${i}. ` + 'параметр '.repeat(28)).trim()).join('\n\n');

const richSpecs = {
  бренд: 'ATLANT', объем_общего_белья_кг: 6, скорость_отжима_об_мин: 1000,
  тип_загрузки: 'фронтальная', цвет: 'белый',
};

const answer = (specs = {}, extra = {}) => JSON.stringify({
  specs: { ...richSpecs, ...specs },
  short_description: 'А'.repeat(130),
  description: mkDesc(),
  bullets: ['пункт один — польза', 'пункт два — польза', 'пункт три — польза'],
  strong: [],
  meta_keywords: 'а, б, в, г, д, е, ж',
  web_info: null,
  ...extra,
});

const reply = (content, { finish = 'stop', usage = { prompt_tokens: 11, completion_tokens: 22, cost: 0.001 }, status = 200, error = null } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Map([['retry-after', '0']]),
  text: () => Promise.resolve(JSON.stringify(error
    ? { error }
    : { choices: [{ finish_reason: finish, message: { content } }], usage })),
});

const sectionText = (v) => {
  if (v == null || (typeof v === 'string' && !v.trim())) return EMPTY;
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
};

console.log('\nEnrichment trace');

await t('успешный model call: 5 секций лога заполнены из фактического запроса', async () => {
  const record = [];
  globalThis.fetch = async (url, opts) => {
    record.push({ url, body: JSON.parse(opts.body) });
    return reply(answer());
  };

  const product = {
    id: '11391',
    name: 'Стиральная машина ATLANT 60С1010',
    category: 'Стиральные машины',
    description: 'Тип загрузки - фронтальная. Максимальная загрузка 6 кг. Скорость отжима 1000 об/мин. Бренд ATLANT. Цвет белый. Установка отдельно стоящая. Тип управления электронный.',
    annotation: 'Модель 60С1010. Стиральная машина ATLANT для дома. Габариты уточняйте в карточке.',
  };

  const r = await enrichProduct(product, {
    model: 'test/model',
    apiKey: 'k',
    limiter: new RateLimiter(60_000),
    maxRetries: 2,
    schema: schemaFor('stiralnye_mashiny'),
  });

  assert.ok(r.debug, 'debug/trace обязателен');
  assert.equal(r.debug.model_called, true);
  assert.ok(r.enriched || r.needs_review, 'ожидаем enriched или needs_review с trace');
  const enrichedForLog = r.enriched || r.debug.enriched_result;
  assert.ok(enrichedForLog, 'enriched result после normalize должен быть в trace');

  const sent = record[0].body.messages;
  assert.equal(r.debug.system_prompt, sent[0].content,
    'system_prompt в логе = messages[0] фактического fetch');
  assert.equal(r.debug.user_content, sent[1].content,
    'user_content в логе = messages[1] фактического fetch');
  assert.equal(r.debug.source_text, sourceText(product));
  assert.ok(
    typeof r.debug.raw_response === 'string' && r.debug.raw_response.includes('"specs"'),
    'raw_response — сырой JSON модели',
  );
  assert.notEqual(r.debug.raw_response, JSON.stringify(enrichedForLog, null, 2));
  assert.notDeepEqual(JSON.parse(r.debug.raw_response), enrichedForLog,
    'raw ≠ enriched после normalize');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-trace-'));
  const store = createJobStore({
    enrichOne: async () => ({
      enriched: r.enriched,
      ...(r.needs_review ? { needs_review: true, validation_issues: r.validation_issues } : {}),
      usage: { prompt_tokens: r.iT, completion_tokens: r.oT, cost: r.cost },
      detail: {
        product: { name: product.name, sku: null, id: product.id },
        status: r.needs_review ? 'needs_review' : 'ok',
        model: 'test/model',
        source_text: r.debug.source_text,
        system_prompt: r.debug.system_prompt,
        user_content: r.debug.user_content,
        raw_response: r.debug.raw_response,
        enriched: enrichedForLog,
        model_status: r.debug.model_status,
        model_called: true,
      },
    }),
    dir,
    log: () => {},
  });

  const job = store.create({
    model: 'test/model',
    category: 'stiralnye_mashiny',
    products: [product],
    indices: [0],
  });
  const until = Date.now() + 5000;
  while (store.get(job.id)?.status === 'running' || store.get(job.id)?.status === 'queued') {
    if (Date.now() > until) break;
    await new Promise(r => setTimeout(r, 20));
  }

  const state = store.state(store.get(job.id), { detailPos: 0 });
  const d = state.detail;
  assert.equal(state.id, job.id, 'runId в ответе');
  assert.equal(d.product?.id, '11391', 'productId в detail');

  for (const [label, val] of [
    ['source_text', d.source_text],
    ['system_prompt', d.system_prompt],
    ['user_content', d.user_content],
    ['raw_response', d.raw_response],
    ['enriched', d.enriched_text || d.enriched],
  ]) {
    const text = sectionText(val);
    assert.notEqual(text, EMPTY, `${label} не должен быть «${EMPTY}»`);
  }

  assert.notEqual(sectionText(d.raw_response), sectionText(d.enriched_text || d.enriched));
  fs.rmSync(dir, { recursive: true, force: true });
});

await t('MODEL_ERROR: ошибочный model call попадает в trace', async () => {
  globalThis.fetch = async () => reply('', {
    status: 502,
    error: { code: 502, message: 'upstream boom' },
  });

  let caught;
  try {
    await enrichProduct({
      name: 'X', category: 'Холодильники',
      description: 'Общий объем, л 310 Вес (кг) 62 Высота 180 см',
    }, {
      model: 'test/model', apiKey: 'k',
      limiter: new RateLimiter(60_000), maxRetries: 1,
      schema: schemaFor('kholodilniki'),
    });
  } catch (e) {
    caught = e;
  }

  assert.ok(caught, 'ожидаем throw');
  assert.ok(caught.debug, 'debug на ошибке');
  assert.equal(caught.debug.model_called, true);
  assert.equal(caught.debug.model_status, 'MODEL_ERROR');
  assert.match(String(caught.debug.raw_response), /MODEL_ERROR/);
  assert.notEqual(sectionText(caught.debug.system_prompt), EMPTY);
  assert.notEqual(sectionText(caught.debug.user_content), EMPTY);
  assert.ok(caught.debug.error);
});

await t('MODEL_EMPTY_RESPONSE: пустой content', async () => {
  globalThis.fetch = async () => reply('   ', { usage: { prompt_tokens: 1, completion_tokens: 0 } });

  let caught;
  try {
    await enrichProduct({
      name: 'X', category: 'Холодильники',
      description: 'Общий объем, л 310 Вес (кг) 62 Высота 180 см Цвет белый Бренд DON',
    }, {
      model: 'test/model', apiKey: 'k',
      limiter: new RateLimiter(60_000), maxRetries: 1,
      schema: schemaFor('kholodilniki'),
    });
  } catch (e) {
    caught = e;
  }

  assert.ok(caught);
  assert.equal(caught.debug?.model_status, 'MODEL_EMPTY_RESPONSE');
  assert.equal(caught.debug?.raw_response, 'MODEL_EMPTY_RESPONSE');
});

await t('MODEL_NOT_CALLED: модель не вызывается', async () => {
  const dbg = modelNotCalledDebug(
    { name: 'Холодильник', description: '' },
    'нет ни description, ни annotation',
  );
  assert.equal(dbg.model_called, false);
  assert.equal(dbg.model_status, 'MODEL_NOT_CALLED');
  assert.match(dbg.system_prompt, /^MODEL_NOT_CALLED:/);
  assert.match(dbg.user_content, /^MODEL_NOT_CALLED:/);
  assert.match(dbg.raw_response, /^MODEL_NOT_CALLED:/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-skip-'));
  const product = { name: 'Холодильник', sku: 'a1' };
  const store = createJobStore({
    enrichOne: async () => ({
      enriched: null,
      skipped: 'нет ни description, ни annotation',
      usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
      detail: {
        product: { name: product.name, sku: 'a1' },
        status: 'skip',
        skipped: 'нет ни description, ни annotation',
        ...dbg,
        enriched: null,
      },
    }),
    dir,
    log: () => {},
  });
  const job = store.create({ model: 'test/model', products: [product], indices: [0] });
  const until = Date.now() + 5000;
  while (store.get(job.id)?.status === 'running' || store.get(job.id)?.status === 'queued') {
    if (Date.now() > until) break;
    await new Promise(r => setTimeout(r, 20));
  }
  const d = store.state(store.get(job.id), { detailPos: 0 }).detail;
  assert.match(String(d.system_prompt), /MODEL_NOT_CALLED/);
  assert.notEqual(sectionText(d.system_prompt), EMPTY);
  assert.notEqual(sectionText(d.raw_response), EMPTY);
  fs.rmSync(dir, { recursive: true, force: true });
});

await t('пример ATLANT 11391: trace из фактического model call', async () => {
  const products = loadProducts('data_467.json');
  const product = products.find(p => String(p.id) === '11391');
  assert.ok(product, 'товар 11391 в data_467.json');

  let sentBody = null;
  globalThis.fetch = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return reply(answer({
      бренд: 'ATLANT',
      объем_общего_белья_кг: 6,
      скорость_отжима_об_мин: 1000,
    }));
  };

  const r = await enrichProduct(product, {
    model: 'test/model',
    apiKey: 'k',
    limiter: new RateLimiter(60_000),
    maxRetries: 2,
    schema: schemaFor('stiralnye_mashiny'),
  });

  assert.ok(r.debug?.model_called);
  assert.equal(r.debug.system_prompt, sentBody.messages[0].content);
  assert.equal(r.debug.user_content, sentBody.messages[1].content);
  assert.ok(r.debug.user_content.includes('ATLANT') || r.debug.user_content.includes('60С1010')
    || r.debug.source_text.includes('ATLANT'));
  assert.ok(r.debug.raw_response.includes('specs'));
  assert.ok(r.enriched || r.needs_review);

  console.log('\n  --- sample enrichment log (ATLANT 11391) ---');
  console.log('  product:', product.name, 'id=', product.id);
  console.log('  model_status:', r.debug.model_status);
  console.log('  source_text:', (r.debug.source_text || '').slice(0, 120) + '…');
  console.log('  system_prompt:', (r.debug.system_prompt || '').slice(0, 80) + '…');
  console.log('  user_content:', (r.debug.user_content || '').slice(0, 120) + '…');
  console.log('  raw_response:', (r.debug.raw_response || '').slice(0, 120) + '…');
  const enr = r.enriched || r.debug.enriched_result;
  console.log('  enriched:', enr ? JSON.stringify({
    short_description: enr.short_description?.slice?.(0, 40),
    specs_keys: Object.keys(enr.specs || {}).slice(0, 5),
  }) : null);
  console.log('  confirmed: system/user taken from fetch body messages[]');
});

await t('три карточки сразу: слот результата совпадает с товаром, даже если вторая готова раньше', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-pool-'));
  const finished = [];
  const store = createJobStore({
    concurrency: 3,
    enrichOne: async (p) => {
      const delay = { A: 70, B: 8, C: 25 }[p.name];
      await new Promise(r => setTimeout(r, delay));
      finished.push(p.name);
      return {
        enriched: { specs: { who: p.name } },
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      };
    },
    dir,
    log: () => {},
  });
  const job = store.create({
    model: 'test/model',
    products: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    indices: [10, 20, 30],
  });
  let sawThree = false;
  const until = Date.now() + 4000;
  while (store.get(job.id)?.status === 'running' || store.get(job.id)?.status === 'queued') {
    if ((store.get(job.id).active || []).length === 3) sawThree = true;
    if (Date.now() > until) break;
    await new Promise(r => setTimeout(r, 5));
  }
  const j = store.get(job.id);
  assert.equal(j.status, 'done');
  assert.ok(sawThree, 'в работе были все три');
  assert.equal(j.results[0].enriched.specs.who, 'A');
  assert.equal(j.results[1].enriched.specs.who, 'B');
  assert.equal(j.results[2].enriched.specs.who, 'C');
  assert.ok(finished.indexOf('B') < finished.indexOf('A'), 'вторая закрылась раньше первой');
  assert.deepEqual(j.active, []);
  assert.equal(j.at_position, -1);
  const st = store.state(j, { details: true });
  assert.equal(st.details[0].status, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});

await t('стоп не берёт новые карточки и дожидается текущих', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-stop-'));
  let started = 0;
  const store = createJobStore({
    concurrency: 3,
    enrichOne: async () => {
      started++;
      await new Promise(r => setTimeout(r, 80));
      return {
        enriched: { specs: { x: 1 } },
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      };
    },
    dir,
    log: () => {},
  });
  const job = store.create({
    model: 'test/model',
    products: [1, 2, 3, 4, 5, 6].map(n => ({ name: String(n) })),
    indices: [0, 1, 2, 3, 4, 5],
  });
  const untilStart = Date.now() + 2000;
  while ((store.get(job.id).active || []).length < 3) {
    if (Date.now() > untilStart) break;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.equal((store.get(job.id).active || []).length, 3);
  store.stop(store.get(job.id));
  const until = Date.now() + 4000;
  while (store.get(job.id)?.status === 'running' || store.get(job.id)?.status === 'queued') {
    if (Date.now() > until) break;
    await new Promise(r => setTimeout(r, 10));
  }
  const j = store.get(job.id);
  assert.equal(j.status, 'stopped');
  assert.equal(started, 3, 'новые слоты после стопа не стартуют');
  assert.equal(j.results.filter(Boolean).length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nOK enrichment trace');
