# Текущий пайплайн AI Enricher (как есть)

Документ описывает поведение кода на момент съёмки. Ничего не предлагается менять. Места, которые выглядят странно, но сделаны намеренно, помечены как **workaround**.

В репозитории сейчас **два контура**, которые сходятся на одних и тех же справочниках, но расходятся на выгрузке:

| Контур | Вход | Обогащение | Выгрузка |
|---|---|---|---|
| CLI магазина | обход mrmag.ru + фид | `enricher_mrmag.js` → `lib.js:enrichProduct` | `catalog.js:writeCategoryFiles` → `products_{id}.json` / `filters_{id}.json` (товар как в фиде + поле `enriched`) |
| Справочник / UI / «JSON v2» | `data_{id}.json` или товары из UI | тот же `enrichProduct` (через `server.js` / `jobs.js`) | `pipeline/export.js:buildCustomerExport` → шесть полей заказчика; UI подписывает файлы `products_{key}.json` / `filters_{key}.json` |

Имени `enricher.js` в дереве нет. Точка входа CLI — `enricher_mrmag.js`. Ядро вызова модели — `lib.js`. Сборка витрины заказчика — `pipeline/export.js`. Отдельный `export_v2.js:buildV2` жив как запасной путь без справочника.

---

## 1. Источник данных

### 1.1. Три источника сырых карточек

**A. Фид магазина** — `https://mrmag.ru/scripts/sync_local/products.json`  
Файл: `catalog.js`, функции `loadFeed`, `crawlCategory`.

Формат: JSON-массив. Индекс по `sku`. Поля, которые дальше реально используются:

- `sku`
- `description` (HTML)
- `annotation` (HTML, обычно `<ul><li>Подпись - значение</li>…`)
- `attributes` — массив `{ name, value }` (если есть)

Для холодильников фид закрывает описания всех sku раздела (экономия 250+ запросов к сайту). Стиральных машин в фиде нет — описания идут со страниц товаров.

**workaround.** Значения из фида прогоняются через тот же `decode`, что и HTML страницы: иначе одно поле приходит в двух видах (`310&nbsp л` vs `310 л`).

**B. Листинг раздела** — `https://mrmag.ru/shop/{slug}`  
Файл: `catalog.js`, `parseListing`, `crawlCategory`.

Листинг отдаёт по 20 товаров и уже содержит всё для автофильтров бренда/цены:

- `sku` (`data-sku`)
- `name` (`itemprop="name"`)
- `product_url`, `image`
- `price` (`itemprop="price"`)
- `available` (schema.org InStock)
- `brand` / `brand_slug` (ссылка `class="mr-brand"` / `/kupit/brand-…`)
- `category` — имя раздела, дописывается при обходе

`id` раздела читается со страницы (`data-category`), не зашивается в код. Если id в `categories.json` и на странице разошлись, файлы пишутся под номером со страницы.

Страницы листинга читаются **все** (фильтр описывает раздел). `OFFSET`/`LIMIT` режут только окно, для которого качаются описания.

**C. Страница товара** — `product_url`  
Файл: `catalog.js`, `parseProductPage`.

- `description` — `itemprop="description"`
- таблица «Характеристики» → `attributes[]` и `annotation` строками `подпись - значение` через `<br>` (тот же вид, что у фида)
- `brand` из `itemprop="brand"`

Кэш HTML: `PAGE_CACHE_DIR` (в Docker `/data/cache`), TTL сутки (`PAGE_CACHE_TTL_MS`). Пауза между запросами к сайту: `CRAWL_GAP_MS` (по умолчанию 250 мс, ~4 rps). User-Agent: `mrmag-enricher/1.0 (+catalog builder)`.

### 1.2. Дамп заказчика `data_{id}.json`

Файлы в корне репозитория и/или на томе: `data_467.json`, `data_523.json`; в Docker ещё `/data/dumps` (`pipeline/dumps.js`).

Формат записи (массив объектов):

```json
{ "id": 11391, "name": "Стиральная машина ATLANT 60С1010", "description": "<p>…</p>", "annotation": "<ul>…</ul>" }
```

Других полей загрузчик CLI не берёт: `pipeline/dict.js:loadProducts` копирует только `id`, `name`, `description`, `annotation`.

Подстановка в прогон: `lib.js:hydrateFromDump` / `mergeDumpIntoProduct` — поиск по `sku`/`id`/`article`. Если дамп длиннее или карточка пустая, берётся дамп. Разные тексты склеиваются **дампом первым**:

**workaround.** Дамп первым, чтобы его факты не затёрлись текстом магазина. Если у товара пустой `name`, а в дампе имя есть — имя берётся из дампа.

### 1.3. Справочники категории

- `dictionaries/attributes_{catId}.json` — атрибуты, синонимы, `value_aliases`, `facet.enabled`, `show_in_annotation`, `order`, `tier`
- `dictionaries/filters_spec_{id}.json`, `values_{id}.json` — оверлеи фасетов
- `dictionaries/benchmarks_{id}.json` — ориентиры для `web_info`
- `categories.json` — `{ id, name }` (и служебные поля магазина)
- `config.json` — пороги покрытия, модель, поиск

В Docker справочники с тома `/data/dictionaries`. При старте недостающие файлы копируются из образа; уже лежащие на томе **не перезаписываются целиком**, в них дописываются только отсутствующие ключи (`pipeline/dict.js`, `mergeMissingDictEntries`). Битый JSON на томе при старте игнорируется, чтобы не уронить сервер.

**workaround.** Корень справочников — `PROJECT_ROOT` рядом с `pipeline/`, не `process.cwd()`. Иначе при старте не из `/app` enrichment не видит `dictionaries/`.

### 1.4. Сборка карточки до модели

Порядок в CLI (`enricher_mrmag.js:fetchProducts`):

1. `loadFeed()` (ошибка фида → предупреждение, описания со страниц)
2. `crawlCategory(url, { feed, offset, limit })`
3. для окна: фид по sku, иначе `parseProductPage`

Порядок в UI/сервере (`server.js` перед `enrichProduct`):

1. товар из загруженного списка / дампа
2. `hydrateFromDump`
3. `ensureSource` (сеть, см. §2.6)
4. `enrichProduct`

Разбор пар ключ–значение из annotation/description: `pipeline/parse.js:extractPairs` (каскад M1 ` - `/`: `, M2 на всю строку если ключ не в справочнике).

**workaround.** M2 на строку вроде «Интерфейс 2D - …»: ключ M1 не в справочнике, иначе хвост теряется. Юридический хвост магазинов («Производитель на свое усмотрение…») срезается `trimLegalTail`.

Нормализация в атрибуты справочника: `pipeline/normalize.js:normalizeProduct` / `ingestPairs` / `setAttr`. Источники помечены уровнями:

| уровень | ранг | откуда |
|---|---|---|
| S0 | 40 | имя, бренд, выведенные флаги |
| S1 | 35 | annotation |
| S2 | 20 | description |
| S3 | 10 | внешняя страница / specs модели |

При конфликте равного ранга первое значение **не обнуляется**.

**workaround.** «Не обнуляем молча: иначе валидный S2 из того же текста теряется из‑за соседней кривой строки». Конфликт → `needs_review`, остаётся первое.

---

## 2. Обогащение (`lib.js` + `enricher_mrmag.js` + `server.js`)

### 2.1. Промпт

Встроенный шаблон: `lib.js:defaultSystemPromptTemplate()` (не отдельный `.txt`/`.md`). Пустой `system_prompt` в настройках означает «использовать этот».

Правка из UI пишется в `config.json` → `model.system_prompts[]` (список с `scope`: `'all'` или массив slug/id) и устаревшее поле `model.system_prompt`. Выбор шаблона: `resolveSystemPrompt` — специфичный scope перекрывает `all`; пустой текст → встроенный шаблон.

Плейсхолдеры подставляются из схемы категории (`promptVarsForSchema`): `{{category_name}}`, `{{subject}}`, `{{hints}}`, `{{axis_rule}}`, `{{dims_order}}`, `{{unit_notes}}`, `{{enums}}`, `{{compressor_default}}`, `{{color_facets}}`, `{{spec_keys}}`, `{{highlight_keys}}`, `{{required_filters}}`, `{{optional_filters}}`.

Схема полей — из `dictionaries/attributes_{id}.json` через `pipeline/schema.js` (`CODE_TO_SPEC` даёт стабильные ключи specs: `tank_material` → `материал_бака`, `height` → `{ key: 'высота_мм', mul: 10 }`, и т.д.).

**workaround (порядок ключей в JSON-ответе).** Тексты карточки в скелете ответа стоят **перед** `specs`. Комментарий в `lib.js`: иначе при обрыве по `max_tokens` закрытый JSON уходит только с характеристиками, а описания пустые; specs потом добираются из facts/attributes в `normalizeResponse`.

**workaround (DeepSeek thinking).** Для моделей `deepseek|qwen|qwq` в тело запроса добавляются `thinking: { type: 'disabled' }`, `reasoning: { enabled: false, effort: 'none' }`, `enable_thinking: false`. Цепочка рассуждений и JSON делят один `max_tokens`; thinking съедает бюджет, `finish_reason=length`, карточка пустая. Чужим моделям эти поля не шлются.

### 2.2. Модель и параметры вызова

Один запрос генерирует **все поля разом** (не раздельные проходы на filters / annotation / description / keywords):

```json
{
  "short_description": "...",
  "description": "...",
  "bullets": [],
  "strong": [],
  "meta_keywords": "...",
  "web_info": null,
  "specs": { …ключи схемы… }
}
```

`annotation_html` модель **не пишет**. Его собирает `pipeline/generate.js:renderAnnotation` из нормализованных `attrs` после прогона.

Тело запроса (`lib.js:buildRequestBody`):

- `model` — из `MODEL` / настроек / UI. CLI по умолчанию `deepseek/deepseek-v3.2`
- `max_tokens` — из настроек (`config.json` сейчас `3200`; потолок настроек 16_000). При обрыве бюджет удваивается до `MAX_COMPLETION_TOKENS = 16_000`
- `temperature`: **0.1**
- `response_format`: `{ type: 'json_object' }`
- `usage`: `{ include: true }`
- timeout: `timeout_ms` (сейчас 60_000)

Эндпоинт по умолчанию: `https://openrouter.ai/api/v1/chat/completions`. Заголовки провайдера OpenRouter из `config.json`: `HTTP-Referer: https://mrmag.ru`, `X-Title: Ogran`. Есть ещё провайдеры DeepSeek и Yandex AI Studio (тот же chat-completions контракт).

`buildSeoOnlyPrompt` / `mergeSeoPackage` помечены `@deprecated`: вторая ветка генерации отключена, ответ модели идёт в выгрузку напрямую.

### 2.3. Rate-limiting

Класс `RateLimiter` в `lib.js` — не классический token-bucket, а **скользящее окно 60 с + минимальная пауза между вызовами**.

- `minDelay = ceil(60_000 / rpm) + extraDelayMs`
- окно: массив timestamp’ов за последнюю минуту; если `window.length >= rpm` — ждать `60_000 - (now - window[0]) + 150` мс
- иначе дождаться `minDelay` с прошлого вызова
- очередь `this.tail`: параллельные вызовы сериализуются

**workaround.** «Очередь обязательна: без неё параллельные вызовы читают одно и то же состояние окна, все проходят проверку и rpm перестаёт соблюдаться.»

Таблица RPM (`MODEL_RPM`):

| модель | RPM |
|---|---|
| `deepseek/deepseek-v3.2`, `deepseek-v3.2-20251201`, `deepseek-chat` | 20 |
| `openai/gpt-4o`, `gpt-4o-mini` | 500 |
| `anthropic/claude-haiku-4-5`, `claude-3-haiku` | 50 |
| `google/gemini-2.5-flash-preview` | 30 |
| `google/gemini-flash-1.5` | 60 |
| любая другая | **20** |

CLI: один лимитер на процесс. Сервер: лимитер на ключ `{providerId}:{model}` (`server.js`).

Параллелизм карточек в фоновом прогоне: `JOB_CONCURRENCY` (по умолчанию 3, максимум 8). Поисковик ходит строго по одному запросу (капча).

Дополнительная пауза CLI: `DELAY` (мс) прибавляется к `minDelay`.

### 2.4. Retry

Константы:

- `config.json` → `model.max_retries`: **2**
- CLI `enricher_mrmag.js`: `SETTINGS?.model?.max_retries || 3`
- сервер: `Math.min(2, settings.model.max_retries || 2)`
- внутри `enrichProduct`: `attemptsCap = min(2, max(1, maxRetries))` — сетевые/HTTP/parse ретраи **не больше двух**, даже если CLI передал 3
- `AI_REPAIR_PASSES = 3` — дополнительные вызовы на правку карточки
- цикл: `repairMax = attemptsCap + AI_REPAIR_PASSES` (до 5 обращений к модели на товар)

HTTP-коды, которые ретраятся: `408, 409, 429, 500, 502, 503, 504, 524`.

Паузы:

| ситуация | пауза |
|---|---|
| сеть / таймаут | `attempt * 3000` мс |
| HTTP retryable | `Retry-After` / `x-ratelimit-reset`, иначе `attempt * 4000` мс (кап 60 с) |
| пустой `choices[]` | `attempt * 5000` мс |
| пустой `content` | `attempt * 5000` мс |
| parse error | 2000 мс |
| normalize error | 2000 мс |
| обрыв `finish_reason=length` | без паузы, `max_tokens` × 2 |

Различие «пустой ответ из-за лимита» vs ошибка:

- HTTP 429 с телом ошибки → `RETRYABLE`, статус `MODEL_ERROR`, ретрай по `Retry-After`
- HTTP 200, `choices` отсутствует или пуст → сообщение `'Нет choices в ответе'`, `lastRaw = 'MODEL_EMPTY_RESPONSE'`, статус **`MODEL_EMPTY_RESPONSE`**, ретрай с паузой 5 с × номер попытки
- HTTP 200, `choices[0].message.content` пустой — то же `MODEL_EMPTY_RESPONSE`
- после исчерпания `attemptsCap`: если уже был удачный `lastEnriched` — он принимается; иначе `fail(..., 'MODEL_EMPTY_RESPONSE')`

Стоимость всех попыток (включая упавшие) суммируется в `_meta` / usage.

### 2.5. Нормализация и санитайзинг ответа LLM

Цепочка после `content`:

1. `parseResponse` (JSON; при обрыве — `repairTruncatedJson`)
2. `normalizeResponse` — приведение specs к схеме, enum/синонимы, `да`/`нет`, обнуление вне списка → `warnings`
3. `crossCheck(specs, facts, bounds, mismatchPolicy)` — приоритет источника
4. `softFixCardTexts` — DeepSeek часто даёт 6 bullets / 97 символов short; чинится без второго запроса (**workaround**: иначе лишний retry, см. `pipeline/model_validate.js`)
5. `validateModelResponse` — длины, число абзацев, запрет HTML в текстах модели, заполненность specs
6. при issues/warnings — feedback в следующий user-JSON (`validation_feedback` / `correction: source_and_dump` + дамп)

Политика расхождений `MISMATCH_POLICY` (env; в `lib.js` дефолт `prefer_source`; в `config.json` → `conditions.mismatch_policy`: `prefer_source`; в `.env.example` комментарий говорит `flag`):

- `prefer_source` — факт источника перекрывает модель, без warning
- `flag` — то же + warning
- `strict` — вне интервала обнулить + warning

Допуски чисел: оси ±20 мм, вес ±1 кг, иначе 2%. Граница полки фильтра тоже с допуском (магазин кладёт 1800 мм в «От 181 до 190 см»).

Прочие нормализации в `lib.js` (намеренные костыли):

- «тип холодильника» = «конструкция…» → Side-by-Side или `null` (не путать с конструкцией корпуса)
- климатический класс: если facts = `N, SN, ST, T`, а модель написала `N` — берётся полный список, warning снимается
- `deriveDefrostFromCooling`: No Frost в охлаждении заполняет оси разморозки камер, иначе витринный фильтр обнуляется, потому что в тексте подписано только охлаждение
- кириллическая «К» в «4К» сводится к латинице, иначе сравнение фасета ломается
- цвет сводится к базовой палитре (`COLOR_FACETS`), чтобы фильтр «Цвет» не разъехался на сотни оттенков

Гейт до модели: `isEnrichable`. Короткий текст сам по себе не отказ — отказ, если длина `< MIN_SOURCE_CHARS` **и** ни одной распознанной характеристики. `MIN_SOURCE_CHARS` из настроек (`min_source_chars`, сейчас 100).

### 2.6. Web-lookup / парсинг фолбэк

Включается, если `WEB_LOOKUP !== '0'` и `config.search.enabled`.

Триггеры (`catalog.js:ensureSource`, `needsWebSpecs` / `isSourceThin`):

1. карточка не проходит `isEnrichable`, но имя опознаваемо (`canSearchWeb`: артикул-токен или бренд+модель)
2. фактов меньше `min_attrs` (сейчас **5**) — даже если текст не пустой
3. фактов хватает, но нет страны производства — отдельный поиск только страны

Порядок поиска страницы (`pipeline/search.js`):

1. Yandex Search API Cloud v2 (`POST /v2/web/search`), если есть ключ + Folder ID
2. свой `SEARCH_URL`
3. DuckDuckGo html/lite, Mojeek/Brave из `fallback_engines`

До `WEB_LOOKUP_TRIES` страниц параллельно, по одной на домен; принимается первая подходящая **в порядке выдачи**. Таймаут страницы товара: `page_timeout_ms` (10 с в config), поиска — `timeout_ms` (20 с).

Страница принимается, только если на ней есть артикул либо все опознавательные слова имени. Иначе характеристики соседней модели.

Чужая таблица **не пишется в `attributes` магазина** — только в `annotation`/`description`. Комментарий: фасеты каталога задаёт магазин; «спор каталога с самим собой» должен оставаться спором каталога.

Локальные адреса из выдачи (`127.0.0.1`, `169.254.169.254`, `10.*`, `*.local`) не читаются (`WEB_ALLOW_LOCAL=1` только для тестов).

Если поиск не удался, товар **всё равно отправляется в модель** с тем, что есть (`gate.ok = true` + причина в `reason`). `WEB_LOOKUP=0`: сеть не трогается, дамп подставляется как раньше.

Отдельный CLI-путь добора: `node cli.mjs lookup` / `enrich --no-external` → `pipeline/external.js:enrichMissing` (S3).

---

## 3. Валидация

Проверка согласованности **есть**, но она не всегда блокирует выгрузку.

### 3.1. До сохранения ответа модели

`validateModelResponse` (`pipeline/model_validate.js`) + `crossCheck` в `normalizeResponse`. Карточка с issues уходит в цикл AI-repair; после исчерпания попыток **последний черновик принимается** (`accept(enriched)`), `needs_review` на этом шаге больше не стопорит товар.

### 3.2. Сборка карточки заказчика (`buildCustomerExport`)

После нормализации, до записи файлов:

1. `completeStorefrontRecs` — добор витринных дыр (мотор, компрессор «Стандартный», harvest из текста в том числе `tank_material` / `drum_material`)
2. `finalizeRecord` (`pipeline/quality_validate.js`): снять неподтверждённые «нет», `alignEnumSurfaces`, `checkAnnotationFacts`, `checkFilterConsistency`, `checkDescriptionClaims`, `stripHallucinationClaims`
3. `runFiltersAgent` — ИИ или эвристика; UI шлёт `filters_agent: 'heuristic'`
4. `buildFilters` + `sanitizeFilterCatalog`
5. `runConsistencyAgent` — сверка description ↔ annotation ↔ filters (эвристика, спорные → ИИ если задан провайдер)
6. повторный `completeStorefrontRecs` / `buildFilters`, если были правки
7. `checkFilterConsistency` ещё раз → `validation_issues` на записи
8. `serializeProducts` → `scrubProductFilterValues` (выбросить ключи вне schema и `[object Object]`)
9. `assertFiltersClean` + `validateProducts`

`checkFilterConsistency`: для каждого `facet.enabled` сравнивает бакет/enum фильтра с точным `attrs[code]`. Расхождение → `kind: 'filter_mismatch'`, `action: 'needs_review'`. Не останавливает serialize.

`validateProducts` (`pipeline/validate.js`) проверяет:

- состав и **порядок** шести полей: `id`, `meta_keywords`, `description_html`, `annotation_html`, `filters`, `web_info`
- **`name` в этом контракте отсутствует намеренно** («заказчик сопоставляет по id»)
- разметку description (4 `<p>`, один `<ul>` на 3–5 `<li>`, 1–3 `<strong>`, без `<h1>`, длина 970–1630)
- annotation: только `ul/li`, разделитель `": "`, ≥ 8 строк, значения без бакетов `55-60`
- ключи `filters` ⊆ `facet.enabled` справочника; range на товаре — бакеты
- `filter_missing` (фасет из schema ни у кого не заполнен) — **не** входит в грязный гейт выгрузки

Гейт `validation.ok` в `buildCustomerExport` смотрит только на «грязные» виды (`dirty_filter_value`, `filter_not_in_aliases`, `filter_object_stringified`, `filter_unknown`, `filter_not_bucketed`, `filter_unit_mismatch`) плюс `assertFiltersClean`. Если `ok === false`, наружу уходят **пустые** `products` и `filters` (HTTP 422 в API).

Неполные карточки (`annotationRows < 8`) остаются в `products` и дублируются в `held`. Комментарий: потеря SKU хуже неполного фильтра. `needs_review` тоже в `products`.

Проверка потери `name` как обязательного поля исходника **на выгрузке шести полей нет** — поля там нет по контракту. На исходнике имя используется для поиска, идентичности и (в v2-шаблоне) подмешивается отдельно, см. §4.

Конфликт текст vs атрибуты магазина до прогона: `source_conflicts` / фильтр UI «Ошибки каталога» (`/api/quality`). Это не сверка с моделью.

---

## 4. Экспорт / выгрузка

Скрипта с именем вида `export_{slug}.js` нет. Имена файлов завязаны на **числовой id категории**, не на slug (`stiralnye_mashiny`). Slug используется для URL обхода и выбора схемы.

### 4.1. Где что лежит

| путь | вход | выход |
|---|---|---|
| `catalog.js:writeCategoryFiles` | товары обхода (+ `enriched` после CLI) | `products_{id}.json` — массив как фид, плюс `enriched`/`skipped`/`error`/`_meta`; `filters_{id}.json` — бренд, цена, фасеты из `enriched.specs` |
| `enricher_mrmag.js` (конец) | JSONL `enriched_{id}.jsonl` + окно обхода | те же два файла; фильтры бренда/цены по **всему разделу** (`cat.items`), фасеты по обработанному окну |
| `cli.mjs enrich` / `export` | `data_{id}.json` или уже `products_{id}.json` | `out/products_{id}.json`, `out/filters_{id}.json`, `out/products_v2_{id}.json`, `out/filters_v2_{id}.json`, `categories_v2.json`, coverage/held/validate |
| `POST /api/export` | `{ products, category }` | `{ products, filters, held, validation, … }` — сборка `buildCustomerExport` |
| `POST /api/export-v2` | то же | при наличии справочника — тот же `buildCustomerExport`, плюс `withCatalogNames`; без справочника — `export_v2.js:buildV2` |
| UI «2 файла» / «JSON v2» (`index_final.html`) | оба бьют в **`/api/export`** | скачивание `products_{key}.json` + `filters_{key}.json`; v2 ещё `categories_v2.json` в zip. `key` = id раздела или `all` |

UI: `loadV2Export` и `loadCustomerExport` — оба `POST /api/export`. Кнопка «JSON v2» (`downloadV2`) вызывает именно `loadCustomerExport()`. Разница только в шаблоне полей при скачивании (`export_templates.two` vs `.v2`).

Комментарий у `srcFilters` в `index_final.html` всё ещё говорит, что витрина v2 считает фасеты через `/api/export-v2`. Текущие кнопки скачивания этот путь не вызывают; `/api/export-v2` жив на сервере (`server.js:apiExportV2`) и в `test_api.mjs`.

### 4.2. Маппинг ключей (рус. / англ.)

Отдельной функции `g(ru, en)` в дереве **нет**. Соответствия такие:

1. **Код атрибута → ключ specs модели** — `pipeline/schema.js:CODE_TO_SPEC`  
   Примеры: `tank_material` → `материал_бака`, `load_max` → `максимальная_загрузка_кг`, `height` → `высота_мм` с множителем 10. Если кода нет в таблице — ключ строится из русской подписи (`attrLabel` / `name`).

2. **Ключ specs → подпись фасета v2 (старый `buildV2`)** — `export_v2.js:splitKey`  
   `объем_общий_л` → «Объем общий, л».

3. **Код атрибута → подпись фильтра витрины** — `facet.label` или `attr.name` в справочнике, плюс `pipeline/approved_filters.js:APPROVED_MAP` (лист заказчика «Тип загрузки» ↔ «Тип загрузки», «Максимальная загрузка белья» ↔ «Загрузка белья, кг», «Вид стиральной машины» ↔ «Тип»).

4. **Синонимы значений** — `value_aliases` в `attributes_*.json` (в т.ч. английские: `inverter`, `stainless`). Сведение регистра/ё: `valueFold`.

5. **Два ключа на один атрибут в v2-фасетах** — `v2FacetSpecKeys`: и ключ из подписи справочника, и `CODE_TO_SPEC`, «чтобы путь ИИ и путь справочника совпали».

Bilingual fallback вида «взять en, если нет ru» в экспорте не реализован.

### 4.3. Сборка итогового объекта товара

**Контур магазина (CLI `writeCategoryFiles`):** spread исходного товара обхода + `enriched` / `skipped` / `_meta`. Поля исходника не выкидываются. `name` остаётся.

**Контур заказчика (`serializeProduct`):** новый объект из шести полей, **не** spread исходника:

```js
{
  id: rec.id,
  meta_keywords: meta,             // из модели, иначе metaKeywords(attrs)
    description_html: descHtml,      // HTML из description/bullets/strong модели, иначе renderDescription;
                                     // затем repairDescriptionHtml(desc, annotation)
    annotation_html: renderAnnotation(rec, dict),  // только attrs с show_in_annotation, без бренда
  filters: asFilterArrays(assigned, rec, dict),  // только facet.enabled, бренд выкинут
  web_info: catalogWebInfo(...)
}
```

`applyEnrichedSpecs`: пустые `attrs` добираются из `enriched.specs`. **setAttr не перезаписывает более приоритетный источник.** Specs модели имеют уровень S3 (ранг 10) — они **не затирают** S1 из annotation.

**workaround.** «Аннотация магазина уже в rec — setAttr не перезаписывает.» Пустое поле модели не затирает факт источника пустым значением: в цикл идут только `val != null && val !== ''`.

После serialize UI/CLI накладывают шаблон (`pipeline/export_template.js:attachExportContext`):

```js
{ name: s.name, sku: s.sku ?? s.id ?? p.id, category, …, ...p }
```

`...p` идёт **после** `name: s.name`. Если в `p` уже есть `name` (в т.ч. `null`), оно перекрывает имя из каталога-источника.

Шаблон `two` (кнопка «2 файла»): в примере **нет** ключа `name` — в файл уходят шесть полей.  
Шаблон `v2`: ключ `name` есть; подставляется из контекста/каталога.

`/api/export-v2` дополнительно вызывает `withCatalogNames`: `name: existing ?? names.get(id) ?? null`. Комментарий: «serializeProduct его не отдаёт, каталог склеивает по id».

Если в пакете есть хотя бы один `enriched` со specs/текстом, `productsForExport` **отбрасывает** карточки без ответа модели (иначе дамп сериализуется как готовый каталог). Пакет без `enriched` (CLI дамп → products) оставляется как есть.

### 4.4. Auto-фильтры бренд и цена

**В контуре магазина** (`catalog.js:buildFilters`) — **в том же скрипте записи файлов**, не отдельным шагом:

- «Бренд»: из листинга (`mr-brand`); дырки дописывает `assignMissingBrands` по словарю той же категории из названия
- **workaround.** Фид `products.json` бренд не отдаёт; без `assignMissingBrands` / бренда из обогащения фильтр «Бренд» был бы пустой на весь раздел. Сколько дописала модель — `assigned_by_ai`
- «Цена»: range по `price`; `price === 0` считается отсутствием цены (иначе весь раздел без цены осел бы в первом диапазоне)
- остальные фасеты: `specFacets` из `enriched.specs` (`export_v2.js`)

**В контуре заказчика** (`pipeline/facets.js:buildFilters`): бренд **жёстко не фасет** (`isBrandAttr` / `brand_not_a_filter`), даже если в справочнике `facet.enabled=true`. Цена листинга в этот файл **не входит**. Состав — `facet.enabled` справочника; числа в бакеты по `facet.step` из словаря (не `niceStep` по разбросу, если kind=range). Покрытие ниже `facet_min_coverage` (70%) — фасет может не попасть в каталог.

`APPROVED_NO` для 467 включает «Материал бака», «Материал барабана», бренд, страну и др.: в `filters_*` их быть не должно, в характеристиках (annotation) — должны, если значение есть.

---

## 5. Известные открытые проблемы (как зафиксировано в коде/тестах)

В исходниках **нет** строк `TODO`/`FIXME`/`HACK` по этой теме. Ниже — поведение, которое тесты и комментарии явно фиксируют, плюс следствия, совпадающие с перечисленными подозрениями.

### 5.1. Поле `name` на части товаров / в части выгрузок

Это не случайный баг сериализатора шести полей, а контракт:

```12:15:pipeline/validate.js
/** Порядок и состав полей записи — без name: заказчик сопоставляет по id. */
export const PRODUCT_FIELDS = [
  'id', 'meta_keywords', 'description_html', 'annotation_html', 'filters', 'web_info',
];
```

Тесты: `test_pipeline.mjs` — `'name не в выгрузке: сопоставление по id'`; исходник с кавычками в имени (`"Indesit"`) в выгрузке шести полей имени нет.

В шаблоне v2 имя **добавляется снаружи**. Если у исходной строки нет `name`/`title` (пустой дамп, только sku), `withCatalogNames` / `attachExportContext` поставят `null` или оставят дыру. UI «products.json без name не маскирует карточку словом „Товар“» (`test_ui.mjs`) — отдельное место карточки интерфейса, не файла выгрузки.

Перекрытие `...p` после `name: s.name` в `attachExportContext`: если в сериализованной строке появится `name: null`, каталожное имя затрётся.

### 5.2. Неполные категорийные фильтры у части товаров

- Выгрузка идёт по окну/прогону, а не обязательно по всему разделу; `without_value` на фасете — сколько обогащённых без значения.
- `held`: < 8 строк annotation — товар в `products`, но фильтр по нему дырявый.
- `filter_missing` пишется в `validate_*.json`, но **не** валит `validation.ok`.
- `facet.enabled=false` / `APPROVED_NO` — ось есть в карточке и нет в `filters_*` (это лист заказчика, не сбой).
- Покрытие фасета < 70% — фасет может не попасть в каталог (`facet_min_coverage`).
- `completeStorefrontRecs` добирает часть осей (тип двигателя, компрессор «Стандартный»); пустое честнее выдуманного «нет» для `OPTIONAL_YES` (дисплей / перенавешиваемые двери у 523).

### 5.3. Расхождение текста и `filters` по одному атрибуту

Это ожидаемый класс, на который повешены агенты, а не скрытый сбой:

- `consistency_agent` / `enum_align` / `checkFilterConsistency` пишут `validation_issues`, товар остаётся в выгрузке
- модель пишет человеческий текст, фильтр — канон/`Есть`/`Нет`/бакет; annotation — точное число, filters — бакет (`10-15`). Путать их в одну строку код считает ошибкой (`annotation_bucketed`)
- `prefer_source` молча чинит specs фактом; текст модели при этом может остаться со старым значением, пока `alignAssembledProse` / consistency-агент не перепишут
- равный приоритет двух значений → `needs_review`, в attrs остаётся первое

### 5.4. «Материал бака» между обогащением и финальным экспортом

Факты в коде, из которых складывается подозрение на потерю:

1. В `data_467.json` у многих товаров в annotation есть строка `Материал бака - пластик` (и варианты).
2. Справочник `dictionaries/attributes_467.json`, код `tank_material`:
   - `show_in_annotation: true` — строка **должна** попасть в `annotation_html`, если `attrs.tank_material` заполнен
   - `facet.enabled: false`, причина: «Не входит в согласованный набор фасетов категории»
   - `coverage_now: 17` — в генераторе справочника покрытие низкое
3. `APPROVED_NO[467]` включает `'Материал бака'` — в `filters_*.json` ключа быть не должно. `APPROVED_MAP` мапит `'Материал бака' → 'Материал бака'`, но `forbiddenFilterKeys` его вычищает.
4. Модель пишет specs-ключ `материал_бака` (`CODE_TO_SPEC`). `applyEnrichedSpecs` добирает **только пустые** attrs (S3 не бьёт S1). Если парсер не сопоставил строку магазина с `tank_material`, модель может заполнить specs, и тогда annotation на выгрузке берётся из attrs после ingest specs.
5. Blacklist: у `drum_material` в blacklist стоит «Материал бака» и наоборот — чтобы оси не съели друг друга при match.
6. `storefront_fill.js` умеет harvest `материал бака` из сплошного текста, если слот ещё пуст.
7. Старый `buildV2` кладёт в filters только `facet.enabled` (+ тип товара) и `skipSpecKey` (бренд/модель/артикул). `материал_бака` при `facet.enabled: false` в `filters` v2 **не попадает**; в `description_html` старого `buildV2` specs без бренда выводятся списком — туда ключ бы попал, если лежит в `enriched.specs`. Текущая UI-v2 идёт через `buildCustomerExport`, не через этот список specs.

Итого по коду: исчезновение из **filters** — следствие листа «нет в фильтре». Исчезновение из **annotation_html** возможно, только если `attrs.tank_material` остался `null` (не сматчилось, не добралось из specs, не harvest). Отдельного FIXME на это нет.

### 5.5. Прочие зафиксированные ловушки (не чинить здесь, только знать)

- `attemptsCap` режет CLI `max_retries: 3` до двух сетевых попыток.
- Пустой `choices[]` и 429 обрабатываются разными статусами и разными паузами.
- `config.json` в образе vs `/data/config.json` на томе: правки UI живут на томе; файл в git сам по себе контейнер не меняет.
- `extra_hosts` для `openrouter.ai` — костыль со сроком годности (адреса 8.47.69.6 / 8.6.112.6).
- В `CODE_TO_SPEC` ключ `noise` задан дважды (хладагент/шум вытяжек); в объекте побеждает последнее присвоение.

---

## 6. Deployment

Файл: `docker-compose.yml`, проект **`name: enricher-docker`** (сеть `enricher-docker_default` — nginx-proxy-manager резолвит `ai-enricher` по имени контейнера). Смена имени проекта ломает домен 502.

### 6.1. Сервисы

| сервис | образ / сборка | роль |
|---|---|---|
| `vless-proxy` (`enricher-vless`, alias `proxy`) | `docker/vless` | SOCKS 1080 / HTTP 7890 внутри сети. Нужен `VLESS_LINK` |
| `proxy-bridge` | `alpine/socat`, profile `ssh-tunnel` | опциональный SSH-мост на host network |
| `enricher` (`ai-enricher`) | `Dockerfile` из корня | Node 24, `CMD ["node", "server.js"]`, порт контейнера 3000 → `127.0.0.1:${HOST_PORT:-3004}` |

Том: `enricher-data:/data` (`cache`, `out`, `jobs`, `dictionaries`, `dumps`, `photos`, `photo_jobs`, `refine_jobs`, `config.json`).

Healthcheck: `GET /healthz` без пароля. `mem_limit` enricher 512m, vless 128m. `stop_grace_period: 15s`. `restart: unless-stopped`.

Базовый образ по умолчанию не Docker Hub: `public.ecr.aws/docker/library/node:24-alpine` (на этой сети TLS к registry-1.docker.io часто обрывается).

### 6.2. Что требует `down && up --build` (или `up -d --build`), а не `restart`

Код и статика **запечены в образ** (`COPY *.js *.mjs *.html`, `COPY pipeline`, `COPY refine`, `COPY dictionaries`, `COPY config.json categories.json`). `restart` подхватывает только процесс и env уже созданного контейнера, не новый слой образа и не новый compose-spec.

Нужен **rebuild**:

- любой `.js` / `.mjs` / `.html` / `pipeline/**` / `refine/**`
- `Dockerfile`, `docker/vless/**`
- смена `NODE_IMAGE`
- добавление нового файла в корень, который импортируется (исторически `socks.js` не попал в перечисление COPY — контейнер крутил restart на оборванном импорте; сейчас `COPY *.js`, лишнее режет `.dockerignore`)
- каталог `refine/` (без `COPY refine` сервер падает на `import('./refine/index.js')`, NPM отдаёт 502)
- запечённые `dictionaries/` в образе (том `/data/dictionaries` при этом **не** затирается целиком: копируются только отсутствующие файлы)

Нужен **recreate** (`compose up -d`, не обязательно `--build`):

- правки `docker-compose.yml` (`extra_hosts`, `environment`, `ports`, `name`, depends_on)
- смена `.env`, которое читается как `env_file` (новые значения в уже созданный контейнер `restart` не всегда вливает)
- `VLESS_LINK`

Достаточно **`restart`** (данные на томе сохраняются, прогон в `JOBS_DIR` доводится):

- падение процесса
- смена только файлов на томе `/data` (настройки UI → `/data/config.json`, дампы, кэш страниц, дописанные справочники на томе)

**workaround (DNS).** На канале сервера ответы для `openrouter.ai` приходят с обнулённым последним октетом (`8.47.69.6` → `8.47.69.0`): TCP «открыт», TLS висит. В compose адреса закреплены через `extra_hosts`. Комментарий: костыль со сроком годности; протухание видно по `/api/models` и `smoke.mjs`.

NPM: если его пересоздадут своим compose, `docker network connect enricher-docker_default nginx_proxy_manager` и **обязательный** `docker restart nginx_proxy_manager` (nginx кэширует резолв).

`proxy_read_timeout` в NPM должен быть ~300s: один `/api/enrich` — до трёх минут с ретраями; иначе 504 при уже списанных токенах.
