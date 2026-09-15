# -*- coding: utf-8 -*-
"""
Проверка наполняемости фильтров: для каждого согласованного («да») фильтра
категории — сколько карточек его заполнили и кому именно не хватает.
Цель по требованию — 100%. Скрипт НЕ подгоняет цифру: честно показывает
факт и, если он ниже 100%, сохраняет полный список id по каждому фильтру
в CSV, чтобы можно было доработать конкретные карточки.

Запуск:
  python3 check_fill_100.py products_467.json products_523.json sheet.csv out_dir/
  python3 check_fill_100.py products_467.json products_523.json - out_dir/
Код возврата: 0 если все согласованные фильтры на 100%, иначе 1.

Исправления относительно исходной версии:
  • знаменатель — только товары своей категории (сушилки/аксессуары в 467 не считаем);
  • [false]/«Нет» — это заполненный ответ, не дыра;
  • добавлены маппинги Тип, Габариты, Цвет корпуса (523);
  • «Размораживание …» — отдельные ключи filters, не свёртка в охлаждение;
  • CSV missing_* пишется только если есть дыры.
"""
import json, re, csv, sys, os
from collections import defaultdict

SHEET_YES_467 = [
    'Тип загрузки', 'Максимальная загрузка белья', 'Максимальная скорость отжима',
    'Класс энергоэффективности', 'Класс стирки', 'Класс эффективности отжима',
    'Уровень шума при стирке', 'Цвет корпуса', 'Тип управления', 'Количество программ',
    'Дисплей', 'Высота', 'Ширина', 'Глубина', 'Габариты (ШхГхВ)', 'Вес',
    'Установка', 'Тип двигателя', 'Сушка',
]
SHEET_YES_523 = [
    'Тип холодильника', 'Количество камер', 'Количество дверей',
    'Расположение морозильной камеры', 'Общий объём', 'Объём холодильной камеры',
    'Объём морозильной камеры', 'Система охлаждения',
    'Размораживание холодильной камеры', 'Размораживание морозильной камеры',
    'Класс энергоэффективности', 'Тип компрессора', 'Уровень шума',
    'Мощность замораживания', 'Высота', 'Ширина', 'Глубина', 'Габариты (ШхВхГ)',
    'Цвет корпуса', 'Тип управления', 'Дисплей', 'Перенавешиваемые двери',
]

def builtin_approved():
    approved = defaultdict(dict)
    for name in SHEET_YES_467:
        approved['Стиральные машины'][name] = True
    for name in SHEET_YES_523:
        approved['Холодильники'][name] = True
    return approved

def load_sheet(path):
    if path in ('-', '--builtin', ''):
        return builtin_approved()
    rows = list(csv.reader(open(path, encoding='utf-8')))
    header_idx = next(i for i, r in enumerate(rows) if r and r[0] == 'Категория')
    approved = defaultdict(dict)
    cat = None
    for r in rows[header_idx + 1:]:
        if not any(r):
            continue
        category, char, meaning, has_filter, values, comment = (r + [''] * 6)[:6]
        if category:
            cat = category
        if not char:
            continue
        approved[cat][char] = has_filter.strip().lower() == 'да'
    if not approved:
        return builtin_approved()
    return approved

MAPPING_467 = {
    'Тип': 'Тип',
    'Вид стиральной машины': 'Тип',
    'Тип загрузки': 'Тип загрузки',
    'Максимальная загрузка белья': 'Загрузка белья, кг',
    'Загрузка белья, кг': 'Загрузка белья, кг',
    'Максимальная скорость отжима': 'Скорость отжима, об/мин',
    'Скорость отжима, об/мин': 'Скорость отжима, об/мин',
    'Класс энергоэффективности': 'Класс энергоэффективности',
    'Класс стирки': 'Класс стирки',
    'Класс эффективности отжима': 'Класс эффективности отжима',
    'Уровень шума при стирке': 'Уровень шума, дБ',
    'Уровень шума, дБ': 'Уровень шума, дБ',
    'Цвет корпуса': 'Цвет корпуса',
    'Цвет': 'Цвет корпуса',
    'Тип управления': 'Тип управления',
    'Количество программ': 'Количество программ',
    'Дисплей': 'Дисплей',
    'Высота': 'Высота, см',
    'Высота, см': 'Высота, см',
    'Ширина': 'Ширина, см',
    'Ширина, см': 'Ширина, см',
    'Глубина': 'Глубина, см',
    'Глубина, см': 'Глубина, см',
    'Габариты': 'Габариты (ШхГхВ)',
    'Габариты (ШхГхВ)': 'Габариты (ШхГхВ)',
    'Вес': 'Вес, кг',
    'Вес, кг': 'Вес, кг',
    'Установка': 'Установка',
    'Тип двигателя': 'Тип двигателя',
    'Сушка': 'Сушка',
}
MAPPING_523 = {
    'Тип холодильника': 'Тип холодильника',
    'Количество камер': 'Количество камер',
    'Количество дверей': 'Количество дверей',
    'Расположение морозильной камеры': 'Расположение морозильной камеры',
    'Общий объём': 'Общий объём, л',
    'Общий объём, л': 'Общий объём, л',
    'Объём холодильной камеры': 'Объём холодильной камеры, л',
    'Объём холодильной камеры, л': 'Объём холодильной камеры, л',
    'Объём морозильной камеры': 'Объём морозильной камеры, л',
    'Объём морозильной камеры, л': 'Объём морозильной камеры, л',
    'Система охлаждения': 'Система охлаждения',
    'Размораживание холодильной камеры': 'Размораживание холодильной камеры',
    'Размораживание морозильной камеры': 'Размораживание морозильной камеры',
    'Класс энергоэффективности': 'Класс энергоэффективности',
    'Тип компрессора': 'Тип компрессора',
    'Уровень шума': 'Уровень шума, дБ',
    'Уровень шума, дБ': 'Уровень шума, дБ',
    'Мощность замораживания': 'Мощность замораживания, кг/сут',
    'Мощность замораживания, кг/сут': 'Мощность замораживания, кг/сут',
    'Высота': 'Высота, см',
    'Высота, см': 'Высота, см',
    'Ширина': 'Ширина, см',
    'Ширина, см': 'Ширина, см',
    'Глубина': 'Глубина, см',
    'Глубина, см': 'Глубина, см',
    'Габариты': 'Габариты (ШхВхГ)',
    'Габариты (ШхВхГ)': 'Габариты (ШхВхГ)',
    'Цвет корпуса': 'Цвет корпуса',
    'Цвет': 'Цвет корпуса',
    'Тип управления': 'Тип управления',
    'Дисплей': 'Дисплей',
    'Перенавешиваемые двери': 'Перенавешиваемые двери',
}

ACCESSORY_RE = re.compile(r'соединительн|элемент\s*ck|комплект\s*для\s*колонн|переходник', re.I)
DRYER_RE = re.compile(r'сушильн|суш(?:ильная)?\s*маш', re.I)
WASHER_RE = re.compile(r'стиральн', re.I)
FRIDGE_RE = re.compile(r'холодильник', re.I)
HOOD_RE = re.compile(r'вытяжк|воздухоочист', re.I)

def find_dump(products_path, tag):
    d = os.path.dirname(os.path.abspath(products_path))
    cwd = os.getcwd()
    for c in (
        os.path.join(d, f'data_{tag}.json'),
        os.path.join(cwd, f'data_{tag}.json'),
        os.path.join(d, os.pardir, f'data_{tag}.json'),
    ):
        if os.path.isfile(c):
            return c
    return None

def attach_names(products, products_path, tag):
    dump_path = find_dump(products_path, tag)
    by_id = {}
    if dump_path:
        data = json.load(open(dump_path, encoding='utf-8'))
        items = data.get('products') if isinstance(data, dict) else data
        for src in items or []:
            if isinstance(src, dict) and src.get('id') is not None:
                by_id[src['id']] = src.get('name') or ''
    for p in products:
        if p.get('name'):
            continue
        p['name'] = by_id.get(p.get('id')) or ''
        if not p['name']:
            html = p.get('annotation_html') or p.get('description_html') or ''
            p['name'] = html

def product_kind(name):
    n = (name or '').replace('ё', 'е')
    if ACCESSORY_RE.search(n) and not WASHER_RE.search(n) and not FRIDGE_RE.search(n):
        return 'accessory'
    if DRYER_RE.search(n) and not WASHER_RE.search(n):
        return 'dryer'
    if WASHER_RE.search(n):
        return 'washer'
    if FRIDGE_RE.search(n):
        return 'fridge'
    if HOOD_RE.search(n):
        return 'hood'
    return 'other'

def is_mismatch(product, expected_kind):
    kind = product_kind(product.get('name') or '')
    if kind == expected_kind or kind == 'other':
        return False
    return True

def is_filled(filters, fkey):
    if not fkey or fkey not in (filters or {}):
        return False
    v = filters[fkey]
    if isinstance(v, list):
        return any(x is not None and x != '' for x in v)
    if isinstance(v, bool):
        return True
    if v is None or v == '':
        return False
    return True

def check_category(cat_name, mapping, products, approved_cat, out_dir, file_tag, expected_kind):
    eligible = [p for p in products if not is_mismatch(p, expected_kind)]
    skipped = len(products) - len(eligible)
    total = len(eligible)
    rows_summary = []
    all_ok = True
    seen_keys = set()
    for sheet_name, is_approved in approved_cat.items():
        if not is_approved:
            continue
        fkey = mapping.get(sheet_name)
        if fkey is None:
            rows_summary.append((sheet_name, None, 0, total, 'нет маппинга на ключ filters'))
            all_ok = False
            continue
        if fkey in seen_keys:
            continue
        seen_keys.add(fkey)
        missing_ids = [p['id'] for p in eligible if not is_filled(p.get('filters') or {}, fkey)]
        filled = total - len(missing_ids)
        pct = 100.0 * filled / total if total else 0.0
        rows_summary.append((sheet_name, fkey, filled, total, f'{pct:.1f}%'))
        if pct < 100.0:
            all_ok = False
            out_path = os.path.join(
                out_dir,
                f'missing_{file_tag}_{re.sub(r"[^A-Za-zА-Яа-я0-9]+", "_", fkey)}.csv',
            )
            with open(out_path, 'w', encoding='utf-8', newline='') as f:
                w = csv.writer(f)
                w.writerow(['id'])
                for pid in missing_ids:
                    w.writerow([pid])

    print(f"\n{'=' * 90}\nНаполняемость фильтров — {cat_name} "
          f"(карточек: {len(products)}, своей категории: {total}, пропуск mismatch: {skipped})\n{'=' * 90}")
    print(f"{'ФИЛЬТР':45} {'ЗАПОЛНЕНО':12} {'ВСЕГО':7} {'%':8} СТАТУС")
    for sheet_name, fkey, filled, tot, pct in rows_summary:
        status = 'OK' if pct == '100.0%' else '<100%'
        print(f"{sheet_name:45} {filled:<12} {tot:<7} {pct:<8} {status}")
    return all_ok

def main():
    p467_path, p523_path, sheet_path, out_dir = sys.argv[1:5]
    os.makedirs(out_dir, exist_ok=True)
    approved = load_sheet(sheet_path)
    p467 = json.load(open(p467_path, encoding='utf-8'))
    p523 = json.load(open(p523_path, encoding='utf-8'))
    if isinstance(p467, dict):
        p467 = p467.get('products') or p467.get('items') or []
    if isinstance(p523, dict):
        p523 = p523.get('products') or p523.get('items') or []
    attach_names(p467, p467_path, '467')
    attach_names(p523, p523_path, '523')

    ok1 = check_category(
        'Стиральные машины', MAPPING_467, p467,
        approved.get('Стиральные машины') or builtin_approved()['Стиральные машины'],
        out_dir, '467', 'washer',
    )
    ok2 = check_category(
        'Холодильники', MAPPING_523, p523,
        approved.get('Холодильники') or builtin_approved()['Холодильники'],
        out_dir, '523', 'fridge',
    )

    print(f"\n{'#' * 90}")
    if ok1 and ok2:
        print("ВСЕ согласованные фильтры заполнены на 100% в обеих категориях (без mismatch).")
        sys.exit(0)
    else:
        print("НЕ ДОСТИГНУТО 100% — списки недостающих id сохранены в", out_dir)
        print("(файлы missing_<категория>_<фильтр>.csv — по одному на каждый неполный фильтр)")
        sys.exit(1)

if __name__ == '__main__':
    main()
