/**
 * enricher_mrmag.js — обогащение товаров mrmag.ru через OpenRouter
 *
 * Запуск:
 *   OPENROUTER_API_KEY=sk-or-v1-... node enricher_mrmag.js
 *   OPENROUTER_API_KEY=sk-or-v1-... OFFSET=0 LIMIT=50 node enricher_mrmag.js
 *
 * На каждую категорию пишутся два файла из требований: products_(id).json и
 * filters_(id).json. id берётся со страницы раздела, фильтры «бренд» и «цена»
 * строятся из самих товаров (см. catalog.js).
 *
 * Ход прогона дописывается построчно в enriched_(id).jsonl — прогон можно
 * прервать и продолжить: уже обработанные SKU пропускаются.
 *
 * Переменные окружения:
 *   MODEL            модель OpenRouter (по умолчанию deepseek/deepseek-v3.2)
 *   CATEGORY         slug, id, название раздела или его адрес (по умолчанию kholodilniki)
 *   OFFSET / LIMIT   окно по разделу; без LIMIT берётся весь раздел
 *   DELAY            дополнительная пауза между запросами, мс
 *   OUT              путь к JSONL (по умолчанию enriched_(id).jsonl)
 *   OUT_DIR          куда писать products_(id).json и filters_(id).json
 *   FRESH=1          начать заново, не продолжая существующий JSONL
 *   MISMATCH_POLICY  prefer_source (по умолчанию) | flag | strict — см. lib.js
 *   MIN_SOURCE_CHARS порог «короткого» текста; товар пропускается, только если
 *                    он короткий И ни одна характеристика в нём не распознана
 *   RUB_PER_USD      курс для рублёвых сумм
 *
 * Стоимость в итоге — сумма по всем попыткам, включая ретраи и товары, которые
 * в итоге упали: они тоже оплачены, и в JSONL их _meta это показывает.
 */

import fs from 'fs';
import path from 'path';
import {
  RateLimiter, enrichProduct, fetchModelPricing, rpmFor,
  schemaFor, isEnrichable, hydrateFromDump, MISMATCH_POLICY,
  RUB_PER_USD, RUB_RATE_DATE, doneStatusLabel, resolveSystemPrompt,
} from './lib.js';
import {
  CATEGORIES, findCategory, crawlCategory, loadFeed,
  buildFilters, writeCategoryFiles, ensureSource,
} from './catalog.js';
import { setupProxy } from './socks.js';
import { loadSettings } from './settings.js';

// ── КОНФИГ ───────────────────────────────────────────────────
const API_KEY    = process.env.OPENROUTER_API_KEY;
const MODEL      = process.env.MODEL || 'deepseek/deepseek-v3.2';
const FRESH      = process.env.FRESH === '1';
const OUT_DIR    = process.env.OUT_DIR || '.';
const SETTINGS   = (() => { try { return loadSettings(); } catch { return null; } })();
const MAX_RETRIES = SETTINGS?.model?.max_retries || 3;
const SYSTEM_PROMPTS = SETTINGS?.model?.system_prompts || [];
const SYSTEM_PROMPT = SETTINGS?.model?.system_prompt || '';

// Категория задаётся slug, id, названием или адресом раздела.
const CATEGORY_KEY = process.env.CATEGORY || 'kholodilniki';
const TARGET = findCategory(CATEGORY_KEY)
  || (/^https?:/.test(CATEGORY_KEY) ? { url: CATEGORY_KEY } : null);
if (!TARGET) {
  console.error(`❌ CATEGORY="${CATEGORY_KEY}" не найдена. Доступны: ` +
    CATEGORIES.map(c => c.slug).join(', ') + ' — либо передайте адрес раздела');
  process.exit(1);
}

/** Целое из окружения с падением на старте — опечатку лучше увидеть сразу. */
function intEnv(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`❌ ${name}="${raw}" — ожидается целое неотрицательное число`);
    process.exit(1);
  }
  return n;
}

const OFFSET = intEnv('OFFSET', 0);
// Без LIMIT берём раздел целиком: файлы категории должны содержать её всю.
const LIMIT_ALL = process.env.LIMIT ? intEnv('LIMIT', 0) : Infinity;
const DELAY  = intEnv('DELAY', 0);

// Таблица rpm живёт в lib.js — сервер и CLI должны знать одни и те же лимиты.
const rpm      = rpmFor(MODEL);
const limiter  = new RateLimiter(rpm, DELAY);
const perItemMs = limiter.minDelay;

// ── ЗАГРУЗКА ТОВАРОВ ─────────────────────────────────────────
/**
 * Обход раздела. Описания холодильников закрывает фид products.json — по sku
 * там есть все товары раздела, и это экономит 250+ запросов к сайту. Стиральных
 * машин в фиде нет, их описания и характеристики идут со страниц товаров.
 */
async function fetchProducts() {
  const feed = await loadFeed().catch(e => {
    console.warn(`⚠ фид недоступен (${e.message}) — описания пойдут со страниц товаров`);
    return null;
  });
  process.stdout.write(`📥 Обходим раздел ${TARGET.name || TARGET.url}`);
  const cat = await crawlCategory(TARGET.url, {
    feed,
    offset: OFFSET,
    limit: LIMIT_ALL,
    onNote: () => process.stdout.write('.'),
  });
  console.log('');
  return { cat, window: cat.products, total: cat.listed };
}

// ── ПРОДОЛЖЕНИЕ ПРОГОНА ──────────────────────────────────────
/**
 * Записи из JSONL по SKU; при повторах побеждает последняя, поэтому удачный
 * повтор вытесняет прежнюю ошибку.
 */
function loadRecords(file) {
  const byS = new Map();
  if (FRESH || !fs.existsSync(file)) return byS;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const sku = rec.original?.sku;
      if (sku != null) byS.set(String(sku), rec);
    } catch { /* битую строку игнорируем — дозапишем товар заново */ }
  }
  return byS;
}

/**
 * Готов — значит обогащён или осознанно пропущен. Записи с ошибкой готовыми
 * НЕ считаются: иначе упавший товар не повторится уже никогда.
 */
const isDone = rec => Boolean(rec && (rec.enriched || rec.skipped));

// ── СОХРАНЕНИЕ TXT ───────────────────────────────────────────
function saveTXT(results, filename, schema, cat) {
  const sep = '═'.repeat(60);
  const lines = [
    `ENRICHER — ${cat.name} (id ${cat.id})`,
    `Дата: ${new Date().toLocaleString('ru')}`,
    `Модель: ${MODEL} | Товаров: ${results.length}`,
    `Курс: ${RUB_PER_USD} ₽/$ на ${RUB_RATE_DATE}`,
    '',
  ];

  for (const [i, r] of results.entries()) {
    const d = r.enriched;
    lines.push(sep, `[${i + 1}] ${r.original?.name || '—'}`, `SKU: ${r.original?.sku ?? '—'}`, sep);

    if (!d) {
      lines.push(r.skipped ? `ПРОПУЩЕН: ${r.skipped}` : `ОШИБКА: ${r.error || 'нет данных'}`, '');
      continue;
    }

    lines.push('ХАРАКТЕРИСТИКИ:');
    let any = false;
    for (const k of schema.specKeys) {
      const v = d.specs?.[k];
      if (v != null) { lines.push(`  ${k}: ${v}`); any = true; }
    }
    if (!any) lines.push('  —');

    if (d.warnings?.length) {
      lines.push('', 'РАСХОЖДЕНИЯ С ТЕКСТОМ:');
      for (const w of d.warnings) {
        lines.push(`  ⚠ ${w.field}: модель "${w.model}"${w.source != null ? `, в тексте "${w.source}"` : ''} — ${w.note}`);
      }
    }

    // Тексты карточки по текущему контракту.
    const texts = [
      ['Краткое описание', 'short_description'],
      ['Описание',         d.description ? 'description' : 'seo_description'],
    ].filter(([, k]) => d[k]);
    if (texts.length) {
      lines.push('', 'КАРТОЧКА:');
      for (const [title, k] of texts) lines.push(`  ${title} (${d[k].length}): ${d[k]}`);
    }
    if (d.meta_keywords) {
      lines.push('', 'КЛЮЧЕВЫЕ ФРАЗЫ:', `  ${d.meta_keywords}`);
    }
    if (d.web_info) {
      lines.push('', 'СРАВНЕНИЕ С РЫНКОМ:', `  ${d.web_info}`);
    }

    for (const [title, key] of [
      ['ПРЕИМУЩЕСТВА', 'bullets'],
      ['АКЦЕНТЫ', 'strong'],
    ]) {
      lines.push('', `${title}:`);
      const arr = d[key] || [];
      if (arr.length) arr.forEach(s => lines.push(`  • ${s}`));
      else lines.push('  —');
    }

    if (r._meta?.cost_usd != null) {
      lines.push('', `Токены: ${r._meta.input_tokens}↑ ${r._meta.output_tokens}↓ | $${r._meta.cost_usd.toFixed(6)} (${r._meta.cost_source})`);
    }
    lines.push('');
  }

  fs.writeFileSync(filename, lines.join('\n'), 'utf-8');
}

// ── MAIN ─────────────────────────────────────────────────────
async function main() {
  if (!API_KEY) {
    console.error('❌ Установите OPENROUTER_API_KEY');
    process.exit(1);
  }

  // До первого запроса: и каталог, и модель ходят через fetch.
  const proxyNotes = [];
  try {
    await setupProxy(l => proxyNotes.push(l.trim()));
  } catch (err) {
    console.error(`❌ SOCKS_PROXY: ${err.message}`);
    process.exit(1);
  }
  for (const n of proxyNotes) console.log(n);

  const { cat, window: products, total } = await fetchProducts();
  const schema = schemaFor(cat.slug) ;
  const OUT_JSONL = process.env.OUT || path.join(OUT_DIR, `enriched_${cat.id}.jsonl`);
  // Прежняя версия писала один общий mrmag_enriched.jsonl. Если начать с чистого
  // enriched_(id).jsonl, все уже обогащённые товары будут оплачены повторно.
  const LEGACY_JSONL = 'mrmag_enriched.jsonl';
  if (!fs.existsSync(OUT_JSONL) && fs.existsSync(LEGACY_JSONL)) {
    console.log(`ℹ Рядом лежит ${LEGACY_JSONL} от прежней версии — там уже оплаченные товары.`);
    console.log(`  Чтобы не платить за них снова:  OUT=${LEGACY_JSONL} node enricher_mrmag.js\n`);
  }

  const prev  = loadRecords(OUT_JSONL);
  const todo  = products.filter(p => !isDone(prev.get(String(p.sku))));
  const ready = products.length - todo.length;
  const retry = todo.filter(p => prev.has(String(p.sku))).length;
  const pricing = await fetchModelPricing(MODEL, API_KEY);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Ogran — ${cat.name} (id ${cat.id})`);
  console.log(`  Раздел:  ${cat.url}`);
  console.log(`  Схема:   ${schema.slug} — ${schema.specKeys.length} полей`);
  console.log(`  Модель:  ${MODEL}${pricing ? '' : '  (тариф не получен — стоимость из ответов API)'}`);
  console.log(`  Лимит:   ${rpm} rpm → пауза ${perItemMs}ms между запросами`);
  console.log(`  Товары:  ${products.length} из ${total} в разделе${OFFSET ? `, offset=${OFFSET}` : ''}`);
  console.log(`  Вывод:   ${OUT_JSONL}${prev.size ? `  (готово: ${ready}, к обработке: ${todo.length}${retry ? `, из них повтор после ошибки: ${retry}` : ''})` : ''}`);
  console.log(`  Политика расхождений: ${MISMATCH_POLICY}`);
  console.log(`${'═'.repeat(60)}\n`);

  // products_(id).json пишется по обработанному окну: с LIMIT это НЕ вся
  // категория, и молчать об этом нельзя. Фильтры считаются по всему разделу.
  if (LIMIT_ALL !== Infinity) {
    console.log(`⚠ LIMIT=${LIMIT_ALL}: в products_${cat.id}.json попадут ${products.length} из ${total} товаров` +
      `  (фильтры при этом по всему разделу)\n`);
  }

  if (!todo.length) {
    console.log('✓ Всё в этом окне уже обработано. FRESH=1 — начать заново.\n');
  }
  console.log(`   ⏱ Примерно: ~${((todo.length * perItemMs) / 60_000).toFixed(1)} мин\n`);
  console.log(`🤖 Обогащаем...\n`);

  // Каталог вывода может не существовать: без этого поток падает на ENOENT
  // уже после обхода раздела, то есть проделанная работа теряется.
  fs.mkdirSync(path.dirname(OUT_JSONL) || '.', { recursive: true });
  const out = fs.createWriteStream(OUT_JSONL, { flags: FRESH ? 'w' : 'a' });
  const write = rec => out.write(JSON.stringify(rec) + '\n');

  let totalIn = 0, totalOut = 0, totalCost = 0, ok = 0, skipped = 0, warned = 0;
  let failed = 0, wastedCost = 0;
  const t0 = Date.now();

  for (const [i, p] of todo.entries()) {
    const name = String(p.name || p.sku || '—').slice(0, 48);
    process.stdout.write(`  [${String(i + 1).padStart(4)}/${todo.length}] ${name.padEnd(48)}...`);

    // Нечего извлекать — не платим за запрос, помечаем и идём дальше.
    // Сначала дамп: пустая карточка магазина может быть полной в data_{id}.json.
    // Пустая/бедная карточка: описание из сети. Достаточно фактов без страны:
    // ищем только страну по модели. ensureSource это делает сам.
    let item = p, sourceUrl = null;
    const prepared = hydrateFromDump(p, schema).product;
    const first = isEnrichable(prepared, schema);
    if (!first.ok && !first.web) {
      write({ original: p, enriched: null, skipped: first.reason, _meta: {} });
      skipped++;
      console.log(` ⊘  пропущен — ${first.reason}`);
      continue;
    }
    const found = await ensureSource(prepared, schema, { onNote: n => process.stdout.write(` [${n}]`) });
    if (!found.gate.ok) {
      write({ original: p, enriched: null, skipped: found.gate.reason, _meta: {} });
      skipped++;
      console.log(` ⊘  пропущен — ${found.gate.reason}`);
      continue;
    }
    item = found.product;
    sourceUrl = found.source ?? null;

    try {
      const { enriched, iT, oT, cost, costSource, corrected } = await enrichProduct(item, {
        model: MODEL, apiKey: API_KEY, limiter, pricing, schema,
        maxRetries: MAX_RETRIES,
        systemPrompt: resolveSystemPrompt(schema, SYSTEM_PROMPTS, SYSTEM_PROMPT),
        onNote: n => process.stdout.write(` [${n}]`),
      });

      totalIn += iT; totalOut += oT; totalCost += cost ?? 0; ok++;
      if (enriched.warnings.length) warned++;

      const parserUsed = Boolean(found.parser || sourceUrl);
      write({
        original: item,          // то, что реально ушло в модель: с добранным текстом
        enriched,
        _meta: {
          model:         MODEL,
          ...(sourceUrl ? { source_url: sourceUrl } : {}),
          ...(parserUsed ? { parser: true } : {}),
          ...(corrected ? { corrected: true } : {}),
          input_tokens:  iT,
          output_tokens: oT,
          cost_usd:      cost == null ? null : +cost.toFixed(6),
          cost_rub:      cost == null ? null : +(cost * RUB_PER_USD).toFixed(4),
          cost_source:   costSource,
          rub_per_usd:   RUB_PER_USD,
        },
      });

      const flag = enriched.warnings.length ? ` ⚠${enriched.warnings.length}` : '';
      const mark = doneStatusLabel({ parser: parserUsed, corrected });
      const tag = mark === 'готово' ? '' : `  ${mark}`;
      console.log(` ✓  in=${String(iT).padStart(4)} out=${String(oT).padStart(4)}  ${cost == null ? '   —   ' : '$' + cost.toFixed(5)}${flag}${tag}`);
    } catch (e) {
      // Неудачные попытки оплачены. Списываем их отдельной строкой, а не в ноль.
      const u = e.usage || { iT: 0, oT: 0, cost: null };
      totalIn += u.iT; totalOut += u.oT;
      wastedCost += u.cost ?? 0;
      failed++;
      write({
        original: p, enriched: null, error: e.message,
        _meta: {
          model: MODEL, input_tokens: u.iT, output_tokens: u.oT,
          cost_usd: u.cost == null ? null : +u.cost.toFixed(6),
        },
      });
      console.log(` ✗  ${e.message}${u.cost ? `  (потрачено ${u.cost.toFixed(5)})` : ''}`);
    }
  }

  await new Promise(r => out.end(r));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`📊 ИТОГ`);
  console.log(`${'━'.repeat(60)}`);
  console.log(`Обработано: ${ok}/${todo.length} за ${elapsed}с`);
  if (skipped) console.log(`Пропущено:  ${skipped} (нет исходного текста)`);
  if (failed)  console.log(`Ошибки:     ${failed}${wastedCost ? ` (впустую ${wastedCost.toFixed(5)})` : ''} — повторятся при следующем запуске`);
  if (warned)  console.log(`С расхождениями: ${warned} — см. warnings в JSONL`);
  console.log(`Токены:     ${totalIn.toLocaleString()}↑  ${totalOut.toLocaleString()}↓`);
  console.log(`Стоимость:  ${(totalCost + wastedCost).toFixed(5)} / ${((totalCost + wastedCost) * RUB_PER_USD).toFixed(3)} ₽  (курс ${RUB_PER_USD} на ${RUB_RATE_DATE})`);

  if (ok > 0) {
    // Прогноз только по оплаченным товарам: пропущенные запросов не делали.
    const perItem = totalCost / ok;
    const billable = Math.round(total * (ok / (ok + skipped)));
    const c = perItem * billable;
    console.log(`\nПрогноз на каталог (${total} товаров, из них платных ~${billable}):`);
    console.log(`  $${c.toFixed(2)} / ${Math.round(c * RUB_PER_USD)} ₽`);
  }
  console.log(`${'━'.repeat(60)}\n`);

  // Два файла категории собираем из JSONL: там и текущий прогон, и предыдущие,
  // поэтому прерванный прогон не обнуляет уже обогащённое.
  const done = loadRecords(OUT_JSONL);
  const merged = cat.products.map(p => {
    const rec = done.get(String(p.sku));
    return {
      ...p,
      enriched: rec?.enriched ?? null,
      ...(rec?.skipped ? { skipped: rec.skipped } : {}),
      ...(rec?.error   ? { error: rec.error }     : {}),
      ...(rec?._meta && Object.keys(rec._meta).length ? { _meta: rec._meta } : {}),
    };
  });

  const enrichedCount = merged.filter(p => p.enriched).length;
  const { productsFile, filtersFile } = writeCategoryFiles(cat, merged, {
    dir: OUT_DIR,
    filterProducts: cat.items,   // фильтр — по разделу, даже если обработано окно
  });
  const f = buildFilters(cat, cat.items);

  const base = path.join(OUT_DIR, path.basename(OUT_JSONL, '.jsonl'));
  saveTXT([...done.values()], `${base}.txt`, schema, cat);

  console.log(`✅ ${productsFile}  (${merged.length} товаров, обогащено ${enrichedCount})`);
  console.log(`✅ ${filtersFile}  (брендов ${f.filters[0].values.length}, цена ${f.filters[1].min}–${f.filters[1].max} ₽)`);
  console.log(`   JSONL → ${OUT_JSONL}   TXT → ${base}.txt\n`);
}

main().catch(e => {
  console.error('\n❌ Ошибка:', e.message);
  process.exit(1);
});
