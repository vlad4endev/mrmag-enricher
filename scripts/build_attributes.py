#!/usr/bin/env python3
"""Собрать attributes_{cat_id}.json из согласованного Excel-справочника."""
from __future__ import annotations

import json
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
XLSX = Path("/Users/vl4endev/Desktop/02_Spravochnik_harakteristik_i_brendov.xlsx")
ROOT = Path(__file__).resolve().parents[1]

# Вид фильтра и шаг — из контракта приёмки, не из разброса данных.
# enabled=true только у фасетов, которые заказчик ждёт в filters_*.json.
FACET_467 = {
    "brand":        {"enabled": True,  "label": "Бренд", "kind": "enum"},
    "load_type":    {"enabled": True,  "label": "Тип загрузки", "kind": "enum"},
    "load_max":     {"enabled": True,  "label": "Загрузка белья, кг", "kind": "enum"},
    "spin_max":     {"enabled": True,  "label": "Скорость отжима, об/мин", "kind": "range", "step": 200},
    "energy_class": {"enabled": True,  "label": "Класс энергоэффективности", "kind": "enum"},
    "noise_wash":   {"enabled": True,  "label": "Уровень шума, дБ", "kind": "range", "step": 5},
    "motor_type":   {"enabled": True,  "label": "Тип двигателя", "kind": "enum"},
    "install":      {"enabled": True,  "label": "Установка", "kind": "enum"},
    "drying":       {"enabled": True,  "label": "Сушка", "kind": "enum"},
    "width":        {"enabled": True,  "label": "Ширина, см", "kind": "range", "step": 5},
    "depth":        {"enabled": True,  "label": "Глубина, см", "kind": "range", "step": 5},
    "height":       {"enabled": True,  "label": "Высота, см", "kind": "range", "step": 5},
    "control_type": {"enabled": True,  "label": "Тип управления", "kind": "enum"},
    "color":        {"enabled": True,  "label": "Цвет корпуса", "kind": "enum"},
}
FACET_523 = {
    "brand":          {"enabled": True,  "label": "Бренд", "kind": "enum"},
    "fridge_type":    {"enabled": True,  "label": "Тип холодильника", "kind": "enum"},
    "chambers":       {"enabled": True,  "label": "Количество камер", "kind": "enum"},
    "freezer_pos":    {"enabled": True,  "label": "Расположение морозильной камеры", "kind": "enum"},
    "vol_total":      {"enabled": True,  "label": "Общий объём, л", "kind": "range", "step": 50},
    "vol_fridge":     {"enabled": True,  "label": "Объём холодильной камеры, л", "kind": "range", "step": 50},
    "vol_freezer":    {"enabled": True,  "label": "Объём морозильной камеры, л", "kind": "range", "step": 50},
    "cooling":        {"enabled": True,  "label": "Система охлаждения", "kind": "enum"},
    "energy_class":   {"enabled": True,  "label": "Класс энергоэффективности", "kind": "enum"},
    "noise":          {"enabled": True,  "label": "Уровень шума, дБ", "kind": "range", "step": 5},
    "compressor_type":{"enabled": True,  "label": "Тип компрессора", "kind": "enum"},
    "freeze_power":   {"enabled": True,  "label": "Мощность замораживания, кг/сут", "kind": "range", "step": 2},
    "height":         {"enabled": True,  "label": "Высота, см", "kind": "range", "step": 5},
    "width":          {"enabled": True,  "label": "Ширина, см", "kind": "range", "step": 5},
    "depth":          {"enabled": True,  "label": "Глубина, см", "kind": "range", "step": 5},
    "control_type":   {"enabled": True,  "label": "Тип управления", "kind": "enum"},
    "color":          {"enabled": True,  "label": "Цвет корпуса", "kind": "enum"},
}

# Выбросы из спецификации: вес 3468 кг, высота 1768 см, расход воды 11000 л.
VALID_RANGE = {
    "load_max": [1, 25],
    "spin_max": [300, 2200],
    "noise_wash": [24.5, 128.0],
    "noise_spin": [30, 100],
    "noise": [15, 90],
    "height": [40, 250],
    "width": [30, 200],
    "depth": [25, 150],
    "weight": [5, 400],
    "water_use": [5, 250],
    "energy_year": [20, 900],
    "programs_qty": [1, 40],
    "vol_total": [15, 1200],
    "vol_fridge": [5, 900],
    "vol_freezer": [1, 600],
    "freeze_power": [0.5, 40],
    "chambers": [1, 5],
    "doors": [1, 5],
    "compressors": [1, 3],
}

TYPE_MAP = {
    "число": "number",
    "целое число": "integer",
    "целое": "integer",
    "из списка": "enum",
    "перечень": "enum",
    "класс": "class_scale",
    "порядковая шкала": "class_scale",
    "да / нет": "boolean",
    "логическое": "boolean",
    "три размера": "dimensions",
    "габариты": "dimensions",
}

# Дополнения, без которых сквозные тесты и покрытие не сходятся,
# а в Excel-вариантах этих написаний нет.
EXTRA_SYN = {
    "display": ["Тип дисплея", "Тип индикации"],
    "install": ["Тип установки"],
    "energy_year": ["Потребляемая энергия", "Годовое потребление электроэнергии", "Взвешенное годовое потребление энергии"],
    "dims": [
        "Ширина х Высота х Глубина без упаковки (см)",
        "Ширина х Высота х Глубина без упаковки",
        "Ширина х Высота х Глубина (см)",
        "Габариты без упаковки",
        "Размеры без упаковки",
        "Габаритные размеры (Ш х В х Г см)",
        "Габаритные размеры",
    ],
}
EXTRA_BLK = {
    "weight": ["Вес брутто (кг)", "Вес брутто, кг", "Масса брутто"],
    "dims": [
        "Ширина х Высота х Глубина в упаковке (см)",
        "Ширина х Высота х Глубина в упаковке",
        "Габариты с учётом упаковки",
        "Размеры товарной упаковки",
    ],
    "noise_wash": [
        "Уровень шума при отжиме",
        "Уровень шума цикла отжима дБ (А)",
        "Уровень шума при отжиме (дБ)",
    ],
}

# Порядок brand=0, чтобы фильтр «Бренд» шёл первым. Остальное — из Excel.
BRAND_ATTR = {
    "code": "brand",
    "name": "Бренд",
    "description": "Производитель, как будет отображаться в карточке и фильтре",
    "type": "enum",
    "unit": None,
    "cardinality": "single",
    "order": 0,
    "show_in_annotation": True,
    "highlight": True,
    "inferable": True,
    "tier": "A",
    "decision_reason": "Идентичность товара; извлекается из наименования без обратной записи",
    "coverage_now": 0,
    "valid_range": None,
}


def shared_strings(z):
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    out = []
    for si in root.findall("m:si", NS):
        out.append("".join(t.text or "" for t in si.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")))
    return out


def colrow(cell):
    ref = cell.get("r", "")
    col = "".join(c for c in ref if c.isalpha())
    row = int("".join(c for c in ref if c.isdigit()) or 0)
    n = 0
    for ch in col:
        n = n * 26 + (ord(ch) - 64)
    return n, row


def sheet_rows(z, sheet, ss):
    root = ET.fromstring(z.read(sheet))
    rows = {}
    for c in root.findall(".//m:c", NS):
        col, row = colrow(c)
        t = c.get("t")
        v = c.find("m:v", NS)
        isel = c.find("m:is", NS)
        if t == "s" and v is not None:
            val = ss[int(v.text)]
        elif t == "inlineStr" and isel is not None:
            val = "".join(t.text or "" for t in isel.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t"))
        elif v is not None:
            val = v.text
        else:
            val = ""
        rows.setdefault(row, {})[col] = val
    return rows


def load_book(path):
    z = zipfile.ZipFile(path)
    ss = shared_strings(z)
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    sheets = [
        (sh.get("name"), sh.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"))
        for sh in wb.findall("m:sheets/m:sheet", NS)
    ]
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    rid_to = {r.get("Id"): r.get("Target") for r in rels}

    def get(name):
        rid = [s[1] for s in sheets if s[0] == name][0]
        target = rid_to[rid]
        if not target.startswith("xl/"):
            target = "xl/" + target
        return sheet_rows(z, target, ss)

    return get


def pct(s):
    s = str(s or "").replace("%", "").replace(",", ".").strip()
    return int(round(float(s))) if s else 0


def yes(s):
    return str(s or "").strip().lower() in {"да", "yes", "true", "1"}


def unit_of(s):
    s = str(s or "").strip()
    return None if s in {"", "—", "-", "–"} else s


def coverage_of(row_pct, cat_name, name):
    return pct(row_pct)


def inferable_of(typ, code):
    if code == "brand":
        return True
    if typ in {"number", "integer", "dimensions"}:
        return False
    return True


def tier_of(code, coverage, facet_map):
    facet = facet_map.get(code) or {}
    if not facet.get("enabled"):
        return "C"
    return "A" if coverage >= 70 else "B"


def facet_of(code, facet_map):
    spec = facet_map.get(code)
    if not spec:
        return {"enabled": False, "reason": "Не входит в согласованный набор фасетов категории"}
    out = {
        "enabled": True,
        "label": spec["label"],
        "kind": spec["kind"],
    }
    if spec["kind"] == "range":
        out["step"] = spec["step"]
        out["bound_rule"] = "left_closed"
        out["open_last"] = True
    return out


def uniq_keep(seq):
    seen = set()
    out = []
    for x in seq:
        k = str(x).strip()
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(k)
    return out


def main():
    get = load_book(XLSX)
    chars = get("2. Характеристики")
    variants = get("3. Варианты названий")
    bans = get("4. Запреты")
    brands = get("6. Бренды")

    syn = defaultdict(lambda: defaultdict(list))
    for i in range(5, max(variants) + 1):
        r = variants.get(i, {})
        cat, name, variant, code = r.get(1, ""), r.get(2, ""), r.get(4, ""), r.get(7, "")
        if code and variant:
            syn[cat][code].append(str(variant).strip())

    black = defaultdict(lambda: defaultdict(list))
    for i in range(5, max(bans) + 1):
        r = bans.get(i, {})
        cat, name, banned, code = r.get(1, ""), r.get(2, ""), r.get(3, ""), r.get(6, "")
        if code and banned:
            black[cat][code].append(str(banned).strip())

    brand_aliases = defaultdict(list)
    for i in range(5, max(brands) + 1):
        r = brands.get(i, {})
        canon, variant = str(r.get(1, "")).strip(), str(r.get(3, "")).strip()
        if canon:
            brand_aliases[canon].append(canon)
        if canon and variant:
            brand_aliases[canon].append(variant)

    by_cat = defaultdict(list)
    for i in range(5, max(chars) + 1):
        r = chars.get(i, {})
        cat = r.get(1, "").strip()
        if not cat:
            continue
        code = str(r.get(10, "")).strip()
        name = str(r.get(2, "")).strip()
        typ = TYPE_MAP[str(r.get(11, "")).strip().lower()]
        unit = unit_of(r.get(12))
        card = "multi" if "нескольк" in str(r.get(13, "")).lower() or "мульти" in str(r.get(13, "")).lower() else "single"
        coverage = coverage_of(r.get(5), cat, name)
        rec = {
            "code": code,
            "name": name,
            "description": str(r.get(3, "")).strip(),
            "type": typ,
            "unit": unit,
            "cardinality": card,
            "order": int(float(r.get(14) or 0)),
            "show_in_annotation": yes(r.get(6)),
            "highlight": yes(r.get(15)),
            "inferable": inferable_of(typ, code),
            "tier": None,  # fill after facet map
            "decision_reason": str(r.get(9) or "").strip() or str(r.get(3, "")).strip(),
            "coverage_now": coverage,
            "valid_range": VALID_RANGE.get(code),
            "synonyms": uniq_keep([name] + syn[cat][code]),
            "blacklist": uniq_keep(black[cat][code]),
        }
        by_cat[cat].append(rec)

    cat_id = {"Стиральные машины": 467, "Холодильники": 523}
    facet_maps = {467: FACET_467, 523: FACET_523}

    for cat, recs in by_cat.items():
        cid = cat_id[cat]
        fmap = facet_maps[cid]
        brand = dict(BRAND_ATTR)
        brand["synonyms"] = uniq_keep(["Бренд", "Производитель", "Марка", "Торговая марка"])
        brand["blacklist"] = ["Артикул", "Модель", "Линейка"]
        brand["value_aliases"] = {k: uniq_keep(v) for k, v in brand_aliases.items()}
        brand["facet"] = facet_of("brand", fmap)
        brand["tier"] = "A"
        out = [brand]
        for rec in recs:
            rec["facet"] = facet_of(rec["code"], fmap)
            rec["tier"] = tier_of(rec["code"], rec["coverage_now"], fmap)
            extra_syn = EXTRA_SYN.get((cid, rec["code"])) or EXTRA_SYN.get(rec["code"])
            extra_blk = EXTRA_BLK.get((cid, rec["code"])) or EXTRA_BLK.get(rec["code"])
            if extra_syn:
                rec["synonyms"] = uniq_keep(rec["synonyms"] + extra_syn)
            if extra_blk:
                rec["blacklist"] = uniq_keep(rec["blacklist"] + extra_blk)
            out.append(rec)
        out.sort(key=lambda x: (x["order"], x["code"]))
        path = ROOT / f"attributes_{cid}.json"
        path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        enabled = [a["code"] for a in out if a["facet"].get("enabled")]
        print(f"{path.name}: {len(out)} attrs, {len(enabled)} facets → {enabled}")


if __name__ == "__main__":
    main()
