/**
 * quality.mjs — аудит качества обогащения по результатам реального прогона.
 *
 *   node quality.mjs                      # mrmag_enriched.jsonl
 *   node quality.mjs out.jsonl kholodilniki
 *
 * Зачем: улучшать промпт и выбирать модель вслепую нельзя. Разметка вручную
 * дорогая, но одна метрика доступна бесплатно уже сегодня — СОГЛАСИЕ С ФАКТАМИ.
 * Там, где регулярка извлекла значение из текста, мы знаем правильный ответ и
 * можем проверить модель. Это точность на проверяемом подмножестве.
 *
 * Вторая метрика — ЗАПОЛНЕНИЕ БЕЗ ОПОРЫ: поле заполнено, но в тексте источника ничего
 * похожего нет. Это зона выдумок; она не доказывает ошибку, но показывает, где
 * модель отвечает уверенно там, где данных не было.
 */

import fs from 'fs';
import { schemaFor, extractFacts, sourceText, SCHEMAS } from './lib.js';

const FILE = process.argv[2] || 'mrmag_enriched.jsonl';
const SCHEMA_KEY = process.argv[3] || 'kholodilniki';
const GOLD_FILE = process.argv[4] || null;   // labelset_done.json из label.html

if (!fs.existsSync(FILE)) {
  console.error(`❌ Нет файла ${FILE}. Сначала запустите обогащение: node enricher_mrmag.js`);
  process.exit(1);
}

const schema = schemaFor(SCHEMA_KEY);
const num = new Set(schema.numericKeys);

// ── ЧТЕНИЕ ───────────────────────────────────────────────────
const records = [];
for (const line of fs.readFileSync(FILE, 'utf-8').split('\n')) {
  if (!line.trim()) continue;
  try { records.push(JSON.parse(line)); } catch { /* битую строку пропускаем */ }
}
if (!records.length) {
  console.error(`❌ В ${FILE} нет разбираемых записей`);
  process.exit(1);
}

// Повторы по SKU: побеждает последняя запись, как и в самом обогащении.
const bySku = new Map();
for (const r of records) {
  const sku = r.original?.sku;
  bySku.set(sku != null ? String(sku) : Symbol(), r);
}
const all = [...bySku.values()];
const ok = all.filter(r => r.enriched);

// ── ПОДСЧЁТ ПО ПОЛЯМ ─────────────────────────────────────────
const stat = Object.fromEntries(schema.specKeys.map(k => [k, {
  filled: 0,        // модель вернула значение
  checkable: 0,     // регулярка тоже нашла значение — есть с чем сверить
  agreed: 0,        // и они сошлись
  groundless: 0,    // заполнено, а в тексте опоры нет
  missed: 0,        // регулярка нашла, а модель оставила null
  examples: [],     // до 3 расхождений для глаз
}]));

const tol = (k, exp) => (k === 'вес_кг' ? 1 : /_мм$/.test(k) ? 20 : Math.max(1, Math.abs(exp) * 0.02));

const same = (k, got, exp) => (typeof exp === 'number' || num.has(k))
  ? Math.abs(Number(got) - Number(exp)) <= tol(k, Number(exp))
  : String(got).toLowerCase().trim() === String(exp).toLowerCase().trim();

let withWarn = 0, totalWarn = 0;

for (const r of ok) {
  const specs = r.enriched.specs || {};
  const facts = r.enriched.source_facts || extractFacts(sourceText(r.original || {}), schema);
  const w = r.enriched.warnings?.length || 0;
  if (w) { withWarn++; totalWarn += w; }

  for (const k of schema.specKeys) {
    const got = specs[k];
    const exp = facts[k];
    const s = stat[k];
    if (got != null) {
      s.filled++;
      if (exp != null) {
        s.checkable++;
        if (same(k, got, exp)) s.agreed++;
        else if (s.examples.length < 3) {
          s.examples.push({ sku: r.original?.sku, model: got, source: exp });
        }
      } else {
        s.groundless++;
      }
    } else if (exp != null) {
      s.missed++;
    }
  }
}

// ── ВЫВОД ────────────────────────────────────────────────────
const pct = (n, d) => (d ? (100 * n / d).toFixed(0) + '%' : '—');
const bar = (n, d, w = 10) => {
  if (!d) return '·'.repeat(w);
  const f = Math.round(w * n / d);
  return '█'.repeat(f) + '·'.repeat(w - f);
};

console.log(`\n${'═'.repeat(78)}`);
console.log(`  Качество обогащения — ${schema.name}`);
console.log(`  Файл: ${FILE}`);
console.log(`${'═'.repeat(78)}\n`);

const errors = all.filter(r => !r.enriched && !r.skipped).length;
const skipped = all.filter(r => r.skipped).length;
console.log(`Записей: ${all.length}   обогащено ${ok.length}   пропущено ${skipped}   ошибок ${errors}`);
console.log(`С расхождениями: ${withWarn} (${pct(withWarn, ok.length)}), всего пометок ${totalWarn}\n`);

if (!ok.length) { console.log('Нечего анализировать — успешных записей нет.\n'); process.exit(0); }

console.log('СОГЛАСИЕ С ТЕКСТОМ — там, где правильный ответ известен из источника');
console.log('(низкое согласие = модель ошибается на проверяемых полях)\n');
console.log('  поле                            заполн.  проверяемо  согласие');

const rows = schema.specKeys.map(k => ({ k, ...stat[k] }))
  .filter(r => r.checkable > 0)
  .sort((a, b) => (a.agreed / a.checkable) - (b.agreed / b.checkable));

for (const r of rows) {
  console.log('  ' + r.k.padEnd(32)
    + pct(r.filled, ok.length).padStart(6)
    + String(r.checkable).padStart(11)
    + '   ' + bar(r.agreed, r.checkable) + ' ' + pct(r.agreed, r.checkable).padStart(4));
}

const noCheck = schema.specKeys.filter(k => stat[k].checkable === 0 && stat[k].filled > 0);
if (noCheck.length) {
  console.log('\n  Проверить нечем (регулярка это поле не извлекает): ' + noCheck.join(', '));
}

console.log('\n\nЗАПОЛНЕНО БЕЗ ОПОРЫ В ТЕКСТЕ — зона выдумок');
console.log('(само по себе не ошибка, но чем выше доля, тем больше модель додумывает)\n');
console.log('  поле                            без опоры  доля от заполненных');
const gl = schema.specKeys.map(k => ({ k, ...stat[k] }))
  .filter(r => r.filled > 0)
  .sort((a, b) => (b.groundless / b.filled) - (a.groundless / a.filled))
  .slice(0, 8);
for (const r of gl) {
  console.log('  ' + r.k.padEnd(32) + String(r.groundless).padStart(9)
    + '   ' + bar(r.groundless, r.filled) + ' ' + pct(r.groundless, r.filled).padStart(4));
}

const missed = schema.specKeys.map(k => ({ k, ...stat[k] })).filter(r => r.missed > 0)
  .sort((a, b) => b.missed - a.missed).slice(0, 6);
if (missed.length) {
  console.log('\n\nПРОПУЩЕНО МОДЕЛЬЮ — регулярка значение нашла, модель вернула null');
  console.log('(это чистая потеря: данные в тексте были)\n');
  for (const r of missed) {
    console.log('  ' + r.k.padEnd(32) + String(r.missed).padStart(5) + ' товаров');
  }
}

const worst = rows.filter(r => r.examples.length).slice(0, 4);
if (worst.length) {
  console.log('\n\nПРИМЕРЫ РАСХОЖДЕНИЙ\n');
  for (const r of worst) {
    console.log('  ' + r.k);
    for (const e of r.examples) {
      console.log(`    SKU ${String(e.sku).padEnd(9)} модель "${e.model}"   в тексте "${e.source}"`);
    }
  }
}

// ── ИТОГ ─────────────────────────────────────────────────────
const totCheck = rows.reduce((s, r) => s + r.checkable, 0);
const totAgree = rows.reduce((s, r) => s + r.agreed, 0);
const totFill = schema.specKeys.reduce((s, k) => s + stat[k].filled, 0);
const totGl = schema.specKeys.reduce((s, k) => s + stat[k].groundless, 0);

console.log(`\n${'─'.repeat(78)}`);
console.log(`Согласие на проверяемых полях: ${totAgree} / ${totCheck} = ${pct(totAgree, totCheck)}`);
console.log(`Заполнено без опоры:           ${totGl} / ${totFill} = ${pct(totGl, totFill)}`);
console.log(`Полнота: ${(totFill / ok.length).toFixed(1)} из ${schema.specKeys.length} полей на товар`);
console.log(`${'─'.repeat(78)}`);
// ── СВЕРКА С ЭТАЛОНОМ ────────────────────────────────────────
// Согласие с регуляркой — приближение: оно молчит там, где регулярка ничего
// не извлекает. Размеченный набор закрывает и эти поля, поэтому если он есть,
// считаем настоящие точность и полноту.
if (GOLD_FILE) {
  if (!fs.existsSync(GOLD_FILE)) {
    console.error(`\n⚠ Нет файла эталона ${GOLD_FILE} — раздел сверки пропущен.\n`);
  } else {
    const gold = JSON.parse(fs.readFileSync(GOLD_FILE, 'utf-8'));
    const byGold = new Map((gold.items || []).map(x => [String(x.sku), x.gold]));
    const paired = ok.filter(r => byGold.has(String(r.original?.sku)));

    if (!paired.length) {
      console.error('\n⚠ Ни один товар из эталона не встретился в прогоне.');
      console.error('  Прогоните обогащение по тем же SKU: node enricher_mrmag.js\n');
    } else {
      const g = Object.fromEntries(schema.specKeys.map(k => [k, { right: 0, wrong: 0, missed: 0, invented: 0, emptyOk: 0 }]));
      for (const r of paired) {
        const specs = r.enriched.specs || {};
        const truth = byGold.get(String(r.original.sku));
        for (const k of schema.specKeys) {
          const got = specs[k], exp = truth?.[k] ?? null;
          const c = g[k];
          if (exp == null && got == null) c.emptyOk++;
          else if (exp == null) c.invented++;
          else if (got == null) c.missed++;
          else if (same(k, got, exp)) c.right++;
          else c.wrong++;
        }
      }
      console.log(`\n\n${'═'.repeat(78)}`);
      console.log(`  СВЕРКА С РАЗМЕЧЕННЫМ ЭТАЛОНОМ — ${paired.length} товаров`);
      console.log(`${'═'.repeat(78)}\n`);
      console.log('  поле                            точность  полнота   выдумано');
      const rank = schema.specKeys.map(k => {
        const c = g[k];
        return { k, c, prec: c.right + c.wrong ? c.right / (c.right + c.wrong) : null,
                      rec: c.right + c.missed + c.wrong ? c.right / (c.right + c.missed + c.wrong) : null };
      }).filter(r => r.prec != null || r.c.invented)
        .sort((a, b) => (a.prec ?? 1) - (b.prec ?? 1));

      for (const r of rank) {
        console.log('  ' + r.k.padEnd(32)
          + (r.prec == null ? '     —' : pct(r.c.right, r.c.right + r.c.wrong).padStart(6))
          + (r.rec == null ? '        —' : pct(r.c.right, r.c.right + r.c.missed + r.c.wrong).padStart(9))
          + String(r.c.invented).padStart(11));
      }
      const R = schema.specKeys.reduce((a, k) => {
        const c = g[k];
        a.right += c.right; a.wrong += c.wrong; a.missed += c.missed; a.invented += c.invented;
        return a;
      }, { right: 0, wrong: 0, missed: 0, invented: 0 });
      console.log(`\n  Точность: ${pct(R.right, R.right + R.wrong)}  (из заполненных моделью — сколько верно)`);
      console.log(`  Полнота:  ${pct(R.right, R.right + R.wrong + R.missed)}  (из имеющихся в эталоне — сколько нашла)`);
      console.log(`  Выдумано: ${R.invented} полей, которых в эталоне нет`);
      console.log(`\n  Это и есть число, по которому сравнивают модели и версии промпта.`);
    }
  }
}

console.log(`
Как пользоваться:
  • Согласие ниже 90% на поле — чините промпт по этому полю или единицам.
  • Высокая доля «без опоры» — модель додумывает; добавьте в промпт запрет
    и пример с null, либо уберите поле из схемы для этой категории.
  • «Пропущено моделью» — данные были, но не извлечены: чаще всего помогает
    передать факты в промпт (buildUserContent уже это умеет).
  • Сравнивайте модели: прогоните выборку каждой и сверьте эти три числа.
  • Есть размеченный эталон? Передайте четвёртым аргументом:
      node quality.mjs mrmag_enriched.jsonl kholodilniki labelset_done.json
`);
