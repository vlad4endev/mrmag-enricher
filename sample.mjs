/**
 * sample.mjs — собирает выборку для ручной разметки и генерирует страницу разметки.
 *
 *   node sample.mjs                       # 80 товаров, холодильники
 *   node sample.mjs 120 kholodilniki      # другой размер выборки
 *
 * На выходе:
 *   labelset.json  — данные выборки (для программ)
 *   label.html     — самодостаточная страница разметки, данные внутри
 *
 * Почему не случайные 80: в каталоге есть форматы описаний, которые ломаются
 * по-разному, и редкие ловушки. Случайная выборка их не поймает, а именно на
 * них модель и ошибается. Поэтому берём по квотам на страту, внутри страты —
 * с разбросом по брендам, детерминированно (порядок не зависит от запуска).
 */

import fs from 'fs';
import { schemaFor, extractFacts, sourceText, stripHtml } from './lib.js';
import { findCategory, FEED_URL } from './catalog.js';

const SIZE = Number(process.argv[2] || 80);
const SCHEMA_KEY = process.argv[3] || 'kholodilniki';
const FEED_CACHE = '.products_cache.json';

const schema = schemaFor(SCHEMA_KEY);
const category = findCategory(SCHEMA_KEY) || findCategory(schema.slug);

// ── ЗАГРУЗКА КАТАЛОГА ────────────────────────────────────────
// Сначала ищем products_(id).json, собранный catalog.js: там товары уже
// отобраны по разделу и дополнены со страниц. Общая выгрузка — запасной путь.
async function loadCatalog() {
  const local = category ? `products_${category.id}.json` : null;
  if (local && fs.existsSync(local)) {
    const rows = JSON.parse(fs.readFileSync(local, 'utf-8'));
    if (Array.isArray(rows) && rows.length) {
      console.log(`Источник: ${local} (собран catalog.js)`);
      return rows;
    }
  }
  if (local) console.log(`Нет ${local} — беру общую выгрузку. Точнее будет после: npm run catalog`);
  const fresh = fs.existsSync(FEED_CACHE) && Date.now() - fs.statSync(FEED_CACHE).mtimeMs < 24 * 3600 * 1000;
  if (fresh) return JSON.parse(fs.readFileSync(FEED_CACHE, 'utf-8'));
  const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(FEED_CACHE, text, 'utf-8');
  return JSON.parse(text);
}

// ── СТРАТЫ ───────────────────────────────────────────────────
// Каждая — отдельный способ, которым разбор может ошибиться.
const STRATA = [
  { key: 'упаковка',    quota: 12, why: 'в тексте есть габариты упаковки — модель может взять их вместо размера товара',
    test: t => /упаковк|брутто|в\s+коробк|с\s+уч[её]т/i.test(t) },
  { key: 'оси-подписаны', quota: 10, why: 'порядок осей указан явно: (Ш×В×Г, мм)',
    test: t => /[швгд]\s*[x×х]\s*[швгд]\s*[x×х]\s*[швгд]\s*[,)]/i.test(t) },
  { key: 'тройка-без-осей', quota: 10, why: 'три числа без подписи осей — порядок неоднозначен',
    test: t => /\d+[.,]?\d*\s*[x×х]\s*\d+[.,]?\d*\s*[x×х]\s*\d+/i.test(t)
            && !/[швгд]\s*[x×х]\s*[швгд]\s*[x×х]\s*[швгд]\s*[,)]/i.test(t) },
  { key: 'по-одной-оси', quota: 8, why: 'размеры подписаны по отдельности: «Ширина - 60 см»',
    test: t => /(ширин|высот|глубин)[а-яё]*\s*[-—:(]/i.test(t) },
  { key: 'диапазон',    quota: 8, why: '«от 300 до 350 л» — это фильтр магазина, а не характеристика',
    test: t => /от\s*\d+[.,]?\d*\s*(?:см|л|мм|кг)?\s*до\s*\d+/i.test(t) },
  { key: 'без-no-frost', quota: 8, why: '«без No Frost» означает капельную — смысл инвертирован (холодильники)',
    test: t => /без\s*[:\-–]?\s*(no\s*frost|ноу\s*фрост)/i.test(t) },
  { key: 'тип-загрузки', quota: 6, why: 'фронтальная/вертикальная загрузка (стиральные машины)',
    test: t => /(фронтальн|вертикальн)[а-яё]*\s*(загрузк|люк)|загрузк[а-яё]*[^.;]{0,24}(фронтальн|вертикальн)/i.test(t) },
  { key: 'таблица',     quota: 6, why: 'единица в скобках перед значением: «Вес (кг) - 72»',
    test: t => /[а-яё]\s*\([а-яё\/\s]+\)\s*[-—]\s*\d/i.test(t) },
  { key: 'мало-фактов', quota: 10, why: 'разбор нашёл ≤3 полей — проверяем, что модель не выдумывает',
    test: (t, f) => f <= 3 },
  { key: 'много-фактов', quota: 8, why: 'разбор нашёл ≥13 полей — проверяем полноту',
    test: (t, f) => f >= 13 },
];

// Детерминированный разброс: одинаковый вход даёт одинаковую выборку.
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

// catalog.js проставляет brand со страницы товара; если его нет — из названия.
const brandOf = p => String(
  p.brand || (String(p.name || '').match(/^\S+\s+([A-Za-zА-Яа-я\-]+)/) || [, '—'])[1]
).toUpperCase();

// ── ОТБОР ────────────────────────────────────────────────────
function pick(catalog) {
  const rows = catalog.map(p => {
    const text = sourceText(p);
    const facts = extractFacts(text, schema);
    return { p, text, facts, n: Object.keys(facts).length, brand: brandOf(p), h: hash(String(p.sku)) };
  }).filter(r => r.text.length > 0);

  const chosen = new Map();          // sku → запись
  const tally = new Map();           // бренд → сколько уже взяли

  for (const st of STRATA) {
    const cands = rows
      .filter(r => !chosen.has(String(r.p.sku)) && st.test(r.text, r.n))
      // сначала бренды, которых ещё мало, внутри — детерминированный разброс
      .sort((a, b) => (tally.get(a.brand) || 0) - (tally.get(b.brand) || 0) || a.h - b.h);

    let taken = 0;
    for (const r of cands) {
      if (taken >= st.quota) break;
      chosen.set(String(r.p.sku), { ...r, strata: [st.key] });
      tally.set(r.brand, (tally.get(r.brand) || 0) + 1);
      taken++;
    }
    if (taken < st.quota) {
      console.warn(`  ⚠ страта «${st.key}»: нашлось ${taken} из ${st.quota}`);
    }
  }

  // Добор до нужного размера — самыми непохожими на уже взятое
  const rest = rows.filter(r => !chosen.has(String(r.p.sku)))
    .sort((a, b) => (tally.get(a.brand) || 0) - (tally.get(b.brand) || 0) || a.h - b.h);
  for (const r of rest) {
    if (chosen.size >= SIZE) break;
    chosen.set(String(r.p.sku), { ...r, strata: ['добор'] });
    tally.set(r.brand, (tally.get(r.brand) || 0) + 1);
  }

  // Отмечаем все страты, в которые товар попадает, — это видно при разметке
  for (const r of chosen.values()) {
    r.strata = STRATA.filter(st => st.test(r.text, r.n)).map(st => st.key);
    if (!r.strata.length) r.strata = ['обычный'];
  }
  return [...chosen.values()].slice(0, SIZE);
}

// ── СБОРКА ───────────────────────────────────────────────────
const catalog = await loadCatalog();
console.log(`Каталог: ${catalog.length} товаров, схема «${schema.name}»\n`);
if (!catalog.length) { console.error('❌ Каталог пуст'); process.exit(1); }
const picked = pick(catalog);

const items = picked.map(r => ({
  sku: String(r.p.sku ?? ''),
  name: r.p.name || '',
  price: r.p.price ?? null,
  url: r.p.product_url || null,
  strata: r.strata,
  source: r.text,
  raw: { description: stripHtml(r.p.description), annotation: stripHtml(r.p.annotation),
         attributes: (r.p.attributes || []).map(x => `${x.name}: ${x.value}`) },
  auto: r.facts,      // предзаполнено разбором — разметчику остаётся подтвердить
  gold: {},           // сюда пишет разметчик
}));

const set = {
  schema: schema.slug, schemaName: schema.name,
  fields: schema.specKeys, numeric: schema.numericKeys,
  size: items.length, items,
};

fs.writeFileSync('labelset.json', JSON.stringify(set, null, 2), 'utf-8');

// ── ОТЧЁТ ────────────────────────────────────────────────────
const byStratum = {};
for (const it of items) for (const s of it.strata) byStratum[s] = (byStratum[s] || 0) + 1;
const brands = {};
for (const r of picked) brands[r.brand] = (brands[r.brand] || 0) + 1;
const autoCells = items.reduce((s, it) => s + Object.keys(it.auto).length, 0);
const totalCells = items.length * schema.specKeys.length;

console.log(`Отобрано: ${items.length} товаров, брендов ${Object.keys(brands).length}\n`);
console.log('Покрытие страт:');
for (const [k, n] of Object.entries(byStratum).sort((a, b) => b[1] - a[1])) {
  const why = STRATA.find(s => s.key === k)?.why || '';
  console.log(`  ${String(n).padStart(3)}  ${k.padEnd(16)} ${why}`);
}
console.log(`\nПредзаполнено разбором: ${autoCells} из ${totalCells} ячеек (${(100 * autoCells / totalCells).toFixed(0)}%)`);
console.log(`Размечать вручную остаётся ~${totalCells - autoCells} ячеек, но большая часть — «нет в тексте».\n`);

// ── СТРАНИЦА РАЗМЕТКИ ────────────────────────────────────────
const payload = JSON.stringify(set).replace(/</g, '\\u003c');
fs.writeFileSync('label.html', PAGE(payload), 'utf-8');
console.log('✅ labelset.json — данные выборки');
console.log('✅ label.html    — откройте в браузере и размечайте\n');
console.log('Когда закончите: кнопка «Выгрузить» → labelset_done.json, затем');
console.log('  node quality.mjs mrmag_enriched.jsonl kholodilniki labelset_done.json\n');

function PAGE(data) {
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Разметка выборки — ${schema.name}</title>
<style>
:root{
  --bg:#e9eef2;--bg2:#fff;--bg3:#f5f8fa;--b1:#e1e7ed;--b2:#cbd5dd;
  --t1:#111a21;--t2:#53616d;--t3:#83929e;--ac:#0c6b91;--ac-w:#e4f1f7;--ac-b:#a8d2e3;
  --green:#14764c;--gbg:#e2f2e9;--amber:#8b5506;--abg:#fbf0d9;
  --serif:Georgia,"Times New Roman",serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--sans);background:var(--bg);color:var(--t1);font-size:13.5px;line-height:1.55;height:100vh;display:flex;flex-direction:column}
header{background:var(--bg2);border-bottom:1px solid var(--b1);padding:11px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;flex-shrink:0}
h1{font-size:14px;font-weight:650}
.prog{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--t2);font-size:12px}
.pbar{flex:1;min-width:120px;height:5px;background:var(--b1);border-radius:3px;overflow:hidden}
.pbar i{display:block;height:100%;background:var(--ac);width:0;transition:width .25s}
button{font-family:var(--sans);cursor:pointer;border-radius:5px;border:1px solid var(--b2);background:var(--bg2);color:var(--t1);padding:6px 12px;font-size:12.5px;transition:all .15s}
button:hover{border-color:var(--ac);color:var(--ac)}
button.pri{background:var(--ac);border-color:var(--ac);color:#fff}
button.pri:hover{filter:brightness(1.12);color:#fff}
main{flex:1;display:flex;overflow:hidden}
.src{width:44%;min-width:280px;overflow-y:auto;padding:20px 24px;border-right:1px solid var(--b1);background:var(--bg2)}
.fields{flex:1;overflow-y:auto;padding:20px 24px;background:var(--bg)}
.nm{font-family:var(--serif);font-size:19px;line-height:1.3;margin-bottom:5px}
.meta{font-family:var(--mono);font-size:10.5px;color:var(--t3);display:flex;gap:9px;flex-wrap:wrap;margin-bottom:14px}
.chips{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:16px}
.chip{font-size:10.5px;padding:2px 8px;border-radius:4px;background:var(--abg);color:var(--amber);border:1px solid #eed5a3;font-weight:600}
.lbl{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--t3);margin:18px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--b2)}
.lbl:first-of-type{margin-top:0}
.txt{font-size:13px;line-height:1.7;color:var(--t2);white-space:pre-wrap;word-break:break-word}
.attr{font-family:var(--mono);font-size:11.5px;color:var(--t2);line-height:1.8}
.row{display:flex;align-items:center;gap:9px;padding:5px 0;border-bottom:1px dotted var(--b1)}
.row label{flex:0 0 46%;color:var(--t2);font-size:12.5px}
.row input{flex:1;min-width:0;font-family:var(--mono);font-size:12.5px;padding:5px 8px;border:1px solid var(--b2);border-radius:4px;background:var(--bg2);color:var(--t1);outline:none}
.row input:focus{border-color:var(--ac);box-shadow:0 0 0 3px rgba(12,107,145,.18)}
.row.auto input{background:var(--gbg);border-color:#b3dbc6}
.row .none{flex:0 0 auto;font-size:11px;padding:3px 8px;color:var(--t3)}
.tag{font-size:9.5px;font-family:var(--mono);color:var(--green);flex:0 0 auto;width:26px;text-align:right}
footer{background:var(--bg2);border-top:1px solid var(--b1);padding:10px 20px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;flex-shrink:0}
.hint{font-size:11px;color:var(--t3)}
kbd{font-family:var(--mono);font-size:10.5px;background:var(--bg3);border:1px solid var(--b2);border-radius:3px;padding:1px 5px}
@media(max-width:820px){main{flex-direction:column}.src{width:100%;border-right:none;border-bottom:1px solid var(--b1);max-height:38vh}}
</style></head><body>
<header>
  <h1>Разметка — ${schema.name}</h1>
  <span class="prog" id="prog">1 / ?</span>
  <span class="pbar"><i id="pbar"></i></span>
  <button onclick="jumpNext()">Следующий неразмеченный</button>
  <button onclick="imp()">Загрузить черновик</button>
  <button class="pri" onclick="exp()">Выгрузить</button>
</header>
<main>
  <div class="src">
    <div class="nm" id="nm"></div>
    <div class="meta" id="meta"></div>
    <div class="chips" id="chips"></div>
    <div class="lbl">Описание</div>
    <div class="txt" id="desc"></div>
    <div id="annBox" style="display:none"><div class="lbl">Аннотация</div><div class="txt" id="ann"></div></div>
    <div id="attrBox" style="display:none"><div class="lbl">Атрибуты</div><div class="attr" id="attr"></div></div>
  </div>
  <div class="fields">
    <div class="lbl">Характеристики — зелёное уже нашёл разбор, проверьте и поправьте</div>
    <div id="rows"></div>
  </div>
</main>
<footer>
  <button onclick="go(-1)">← Назад</button>
  <button class="pri" onclick="go(1,true)">Подтвердить и дальше →</button>
  <button onclick="fillEmpty()">Заполнить пустые из разбора</button>
  <button onclick="clearAll()">Очистить товар</button>
  <span class="hint"><kbd>←</kbd> <kbd>→</kbd> переход · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> подтвердить · пустое = «нет в тексте» · стрелки листают без подтверждения</span>
</footer>
<script>
'use strict';
const SET=${data};
const KEY='labelset.'+SET.schema;
let i=0;

// Черновик держим в localStorage: разметка на 80 товаров — не один присест.
try{const s=JSON.parse(localStorage.getItem(KEY)||'null');
    if(s&&s.length===SET.items.length) SET.items.forEach((it,k)=>{
      const v=s[k]||{}; it.gold=v.gold||{}; it.reviewed=!!v.reviewed;});}catch{}

const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(SET.items.map(x=>({gold:x.gold,reviewed:!!x.reviewed}))));}catch(e){console.warn(e)}};
const done=it=>it.reviewed===true;   // подтверждено человеком, а не просто пролистано
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function render(){
  const it=SET.items[i];
  document.getElementById('nm').textContent=it.name;
  const m=[];
  if(it.sku) m.push('арт. '+it.sku);
  if(it.price!=null) m.push(Number(it.price).toLocaleString('ru')+' ₽');
  m.push(it.source.length+' символов');
  document.getElementById('meta').textContent=m.join('  ·  ');
  document.getElementById('chips').innerHTML=it.strata.map(s=>'<span class="chip">'+esc(s)+'</span>').join('');
  document.getElementById('desc').textContent=it.raw.description||'(пусто)';
  document.getElementById('annBox').style.display=it.raw.annotation?'':'none';
  document.getElementById('ann').textContent=it.raw.annotation||'';
  document.getElementById('attrBox').style.display=it.raw.attributes.length?'':'none';
  document.getElementById('attr').textContent=it.raw.attributes.join('\\n');

  document.getElementById('rows').innerHTML=SET.fields.map(f=>{
    const auto=it.auto[f];
    const val=f in it.gold?it.gold[f]:(auto!=null?auto:'');
    const isAuto=auto!=null&&!(f in it.gold);
    return '<div class="row'+(isAuto?' auto':'')+'">'
      +'<label for="f_'+f+'">'+esc(f.replace(/_/g,' '))+'</label>'
      +'<input id="f_'+f+'" data-f="'+f+'" value="'+esc(val===null?'':val)+'" placeholder="нет в тексте">'
      +'<span class="tag">'+(auto!=null?'разбор':'')+'</span></div>';
  }).join('');

  renderProgress();
}

function renderProgress(){
  const n=SET.items.filter(done).length;
  document.getElementById('prog').textContent=(i+1)+' / '+SET.items.length+'   подтверждено '+n;
  document.getElementById('pbar').style.width=(100*n/SET.items.length)+'%';
}

function collect(confirmIt){
  const it=SET.items[i];
  if(confirmIt) it.reviewed=true;
  const g={};
  document.querySelectorAll('#rows input').forEach(inp=>{
    const v=inp.value.trim();
    g[inp.dataset.f]=v===''?null:(SET.numeric.includes(inp.dataset.f)&&!isNaN(Number(v.replace(',','.')))?Number(v.replace(',','.')):v);
  });
  it.gold=g; save();
}
function go(d,confirmIt){ collect(confirmIt); i=Math.max(0,Math.min(SET.items.length-1,i+d)); render(); window.scrollTo(0,0); }
function jumpNext(){ collect(); const k=SET.items.findIndex(x=>!done(x)); if(k>=0){i=k;render();} else alert('Все товары размечены.'); }
// Заполняет только пустые поля: затирать набранное руками в инструменте
// разметки недопустимо — это молча портит эталон.
function fillEmpty(){ const it=SET.items[i]; document.querySelectorAll('#rows input').forEach(inp=>{
  const a=it.auto[inp.dataset.f];
  if(inp.value.trim()==='' && a!=null) inp.value=a; }); collect(true); render(); }
function clearAll(){ document.querySelectorAll('#rows input').forEach(inp=>inp.value=''); collect(); render(); }

function exp(){
  collect();
  const n=SET.items.filter(done).length;
  if(!n){ alert('Пока ничего не подтверждено.'); return; }
  if(n<SET.items.length&&!confirm('Подтверждено '+n+' из '+SET.items.length+'. Выгрузить только их?')) return;
  const out={schema:SET.schema,fields:SET.fields,numeric:SET.numeric,
    items:SET.items.filter(done).map(x=>({sku:x.sku,name:x.name,gold:x.gold}))};
  const b=new Blob([JSON.stringify(out,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='labelset_done.json';a.click();
  URL.revokeObjectURL(a.href);
}
function imp(){
  const f=document.createElement('input');f.type='file';f.accept='.json';
  f.onchange=()=>{const r=new FileReader();
    r.onload=()=>{try{
      const d=JSON.parse(r.result);
      const by=new Map((d.items||[]).map(x=>[String(x.sku),x.gold]));
      let n=0; for(const it of SET.items){ if(by.has(it.sku)){ it.gold=by.get(it.sku); it.reviewed=true; n++; } }
      save(); render(); alert('Загружено '+n+' размеченных товаров.');
    }catch(e){alert('Не удалось прочитать: '+e.message)}};
    r.readAsText(f.files[0]);};
  f.click();
}
// Правка поля — это работа над товаром, значит он подтверждён.
document.addEventListener('input',e=>{
  if(e.target.matches('#rows input')){ SET.items[i].reviewed=true; renderProgress(); }
});
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'&&!(e.ctrlKey||e.metaKey)){ if(e.key==='Enter') go(1,true); return; }
  if(e.key==='ArrowLeft') go(-1);      // листаем без подтверждения
  if(e.key==='ArrowRight') go(1);
  if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)) go(1,true);
});
render();
</script></body></html>`;
}
