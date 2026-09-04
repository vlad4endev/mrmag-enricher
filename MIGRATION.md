# MIGRATION: зашитая логика характеристик и фасетов

Инвентарь мест, где в коде (или генераторе справочников) зашиты
имена характеристик, признак «идёт в фильтр», вид фильтра, шаг,
диапазоны и порядок. Объём работ перед выносом в `dictionaries/`.

---

## A. Генератор справочников

### [`scripts/build_attributes.py`](scripts/build_attributes.py)

| Строки | Что зашито | Контролирует |
|--------|------------|--------------|
| 17–32 | `FACET_467` — brand, load_type, load_max (enum), spin_max (range, step 200), energy_class, noise_wash (step 5), motor_type, install, drying, width/depth/height (step 5), control_type, color | enabled, kind, step, label |
| 33–51 | `FACET_523` — brand, fridge_type, chambers, freezer_pos, vol_* (step 50), cooling, energy_class, noise (step 5), compressor_type, freeze_power (step 2), dims (step 5), control_type, color | то же для холодильников |
| 54–74 | `VALID_RANGE` — load_max [1,25], spin_max [300,2200], noise_*, height/width/depth, weight, water_use, energy_year, programs_qty, vol_*, freeze_power, chambers, doors, compressors | допустимые числовые диапазоны |
| 76–88 | `TYPE_MAP` («число»→number, «из списка»→enum, …) | типы атрибутов при сборке из Excel |
| 92–105 | `EXTRA_SYN` — display, install, energy_year, dims («Ширина х Высота х Глубина без упаковки», …) | синонимы |
| 106–119 | `EXTRA_BLK` — вес брутто, габариты в упаковке, шум при отжиме → noise_wash | blacklist |
| 121–137 | `BRAND_ATTR` order=0, синонимы Бренд/Производитель/Марка, blacklist Артикул/Модель/Линейка | порядок и идентичность |
| 225–229 | `tier_of`: A если coverage≥70 и facet enabled, иначе B/C | tier |
| 241–244 | `bound_rule: left_closed`, `open_last: true` для range | границы бакетов |
| 322 | `{"Стиральные машины": 467, "Холодильники": 523}` | привязка категории |

Материализованная копия: корневые `attributes_467.json` (27 attrs, 14 facets),
`attributes_523.json` (31 attrs, 17 facets) — переносятся в `dictionaries/`.

---

## B. Пайплайн нормализации

| Файл | Что зашито | Куда уходит |
|------|------------|-------------|
| `pipeline/dict.js` | путь `attributes_{id}.json` в корне | `dictionaries/` |
| `pipeline/text.js` | `normKey` снимает все скобки и единицы агрессивнее спецификации | формула задачи 5 (скобки только с единицей, хвостовая единица после запятой, «не более/макс/прибл») |
| `pipeline/match.js` | точное → blacklist → shorten → fuzzy 0.93; нет множества слов 0.95 | blacklist первым; exact 1.0; bag-of-words 0.95; fuzzy из config |
| `pipeline/parse.js` | сначала ` - `/`: `; нет M3; нет отброса заголовков; костыль отрезания «2D» | каскад M1–M4; заголовки; M2 раньше M1 без разделителя |
| `pipeline/facets.js` | бакет от `floor(v/step)*step`; нет ряда от min категории; нет «последний закрытый включает правую»; нет проверки суммы counter; `?? 70` | задача 8 + config |
| `pipeline/dimensions.js` | разделители x/×; нет `*` / «на»; нет сверки 5% с отдельными осями | задача 7 |
| `pipeline/normalize.js` | `inferable`, tier X/C не влияют на маппинг/карточку/дообогащение | задачи 3–4 |
| `pipeline/v2.js` | `PRODUCT_TYPE` 467/523; `CODE_TO_SPEC`; snapCooling / камеры | справочник + `categories.json` |
| `pipeline/identity.js` | `GENERIC` со словами стиральн*/холодильник* | тип из имени категории |

**Оставляем в коде** (не характеристики категории): `isPackingKey`, словари
`BOOL_*` / `CLASS_CYR` / конвертеры единиц — нормализаторы типов.

---

## C. ИИ / каталог / JSON v2

| Файл | Что зашито |
|------|------------|
| `lib.js` ~243–597 | `FRIDGE_RANGE`, `WASHER_RANGE`, `FRIDGE_LABELS`, `WASHER_LABELS`, `fridgeFacts` / `washerFacts`, `SCHEMAS.kholodilniki` (id 523), `SCHEMAS.stiralnye_mashiny` (id 467), enum-списки, ranges в мм |
| `export_v2.js` 51–80 | `DISCRETE_MAX=6`, `TARGET_BUCKETS=8`, `NICE`, `niceStep` **по разбросу данных** — запрещено контрактом для категорий со справочником |
| `catalog.js` 49–50, 611 | константы разделов 523/467; `priceStep` по размаху (цена листинга — не характеристика; оставляем) |
| `test.mjs` | эталоны extractFacts под зашитые схемы холодильников/стиралок |

Остальные `SCHEMAS` без файла справочника не трогаем. Появление
`dictionaries/attributes_{id}.json` → схема/фасеты/extract из него.

---

## D. Пороги в коде → только config

| Место | Значение | Цель |
|-------|----------|------|
| `pipeline/match.js` | default `fuzzyMin = 0.93` | `config.fuzzy.min_score` (контракт: 0.90) |
| `pipeline/facets.js` | `?? 70` | `config.facet_min_coverage` |
| `scripts/build_attributes.py` | `coverage >= 70` для tier A | убрать из генератора / tier из JSON |

`config.json` уже содержит `facet_min_coverage: 70`, `target_coverage: 90`.
Отдельный `config.yaml` не вводим.

---

## E. Порядок вывода

- `order` в каждом атрибуте JSON (brand=0, далее из Excel / справочника).
- `pipeline/dict.js` сортирует `attrs` по `order`.
- Фильтры и карточка должны итерировать тот же порядок.

---

## Критерий готовности миграции

В коде не остаётся имён характеристик категории, видов фильтров, шагов и
диапазонов для категорий со справочником. Новая категория =
`dictionaries/attributes_{cat_id}.json` без правок кода.
