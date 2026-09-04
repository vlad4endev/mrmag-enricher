#!/usr/bin/env python3
"""Обновить synonyms/blacklist/coverage в dictionaries/attributes_{id}.json из Excel.

Источник истины по facet / tier / valid_range / value_aliases — уже лежащий JSON.
Скрипт не задаёт FACET_*/VALID_RANGE/EXTRA_* в коде: новая категория = новый JSON.
"""
from __future__ import annotations

import json
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
XLSX = Path("/Users/vl4endev/Desktop/02_Spravochnik_harakteristik_i_brendov.xlsx")
ROOT = Path(__file__).resolve().parents[1]
DICT_DIR = ROOT / "dictionaries"

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


def inferable_of(typ, code):
    if code == "brand":
        return True
    if typ in {"number", "integer", "dimensions"}:
        return False
    return True


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


def load_existing(cid: int) -> dict[str, dict]:
    path = DICT_DIR / f"attributes_{cid}.json"
    if not path.exists():
        raise SystemExit(
            f"Нет {path}: создайте dictionaries/attributes_{cid}.json вручную "
            f"(facet/tier/valid_range), затем перезапустите скрипт для синонимов из Excel."
        )
    return {a["code"]: a for a in json.loads(path.read_text(encoding="utf-8"))}


def main():
    if not XLSX.exists():
        raise SystemExit(f"нет файла {XLSX}")

    get = load_book(XLSX)
    attrs_sheet = get("Атрибуты")
    syn_sheet = get("Синонимы")
    black_sheet = get("Чёрный список")
    brand_sheet = get("Бренды")

    syn = defaultdict(lambda: defaultdict(list))
    for r in syn_sheet.values():
        cat = str(r.get(1, "")).strip()
        code = str(r.get(2, "")).strip()
        name = str(r.get(3, "")).strip()
        if cat and code and name:
            syn[cat][code].append(name)

    black = defaultdict(lambda: defaultdict(list))
    for r in black_sheet.values():
        cat = str(r.get(1, "")).strip()
        code = str(r.get(2, "")).strip()
        name = str(r.get(3, "")).strip()
        if cat and code and name:
            black[cat][code].append(name)

    brand_aliases = defaultdict(list)
    for r in brand_sheet.values():
        canon = str(r.get(1, "")).strip()
        alias = str(r.get(2, "")).strip()
        if canon and alias:
            brand_aliases[canon].append(alias)

    # Excel category name → cat_id only for known shop sections that already have a dictionary.
    cat_id = {}
    for path in sorted(DICT_DIR.glob("attributes_*.json")):
        cid = int(path.stem.split("_")[1])
        # Resolve name from categories.json when possible.
        cats_path = ROOT / "categories.json"
        name = None
        if cats_path.exists():
            for c in json.loads(cats_path.read_text(encoding="utf-8")):
                if int(c["id"]) == cid:
                    name = c["name"]
                    break
        if name:
            cat_id[name] = cid

    by_cat = defaultdict(list)
    for r in attrs_sheet.values():
        cat = str(r.get(1, "")).strip()
        code = str(r.get(2, "")).strip()
        name = str(r.get(4, "")).strip()
        if not cat or not code or code == "code" or cat not in cat_id:
            continue
        typ_raw = str(r.get(10, "")).strip().lower()
        typ = TYPE_MAP.get(typ_raw, "string")
        unit = unit_of(r.get(11))
        card = "multi" if "нескольк" in str(r.get(13, "")).lower() or "мульти" in str(r.get(13, "")).lower() else "single"
        coverage = pct(r.get(5))
        by_cat[cat].append({
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
            "decision_reason": str(r.get(9) or "").strip() or str(r.get(3, "")).strip(),
            "coverage_now": coverage,
            "synonyms": uniq_keep([name] + syn[cat][code]),
            "blacklist": uniq_keep(black[cat][code]),
        })

    DICT_DIR.mkdir(parents=True, exist_ok=True)

    for cat, recs in by_cat.items():
        cid = cat_id[cat]
        existing = load_existing(cid)
        out = []

        # Brand: keep facet/tier/aliases from JSON; refresh value_aliases from Excel when present.
        if "brand" in existing:
            brand = dict(existing["brand"])
            brand["synonyms"] = uniq_keep(
                brand.get("synonyms") or ["Бренд", "Производитель", "Марка", "Торговая марка"]
            )
            brand["blacklist"] = uniq_keep(brand.get("blacklist") or ["Артикул", "Модель", "Линейка"])
            if brand_aliases:
                brand["value_aliases"] = {k: uniq_keep(v) for k, v in brand_aliases.items()}
            out.append(brand)

        for rec in recs:
            if rec["code"] == "brand":
                continue
            prev = existing.get(rec["code"], {})
            merged = {
                **rec,
                # Не перетираем контракт справочника полями из генератора.
                "tier": prev.get("tier", "C"),
                "facet": prev.get("facet", {"enabled": False, "reason": "Нет в dictionaries/attributes JSON"}),
                "valid_range": prev.get("valid_range"),
                "coverage_final": prev.get("coverage_final", rec["coverage_now"]),
                "synonyms": uniq_keep((prev.get("synonyms") or []) + rec["synonyms"]),
                "blacklist": uniq_keep((prev.get("blacklist") or []) + rec["blacklist"]),
            }
            if prev.get("value_aliases"):
                merged["value_aliases"] = prev["value_aliases"]
            if prev.get("inferable") is not None:
                merged["inferable"] = prev["inferable"]
            out.append(merged)

        # Preserve attributes that exist only in JSON (not in this Excel run).
        seen = {a["code"] for a in out}
        for code, prev in existing.items():
            if code not in seen:
                out.append(prev)

        out.sort(key=lambda x: (x.get("order", 0), x["code"]))
        path = DICT_DIR / f"attributes_{cid}.json"
        path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        enabled = [a["code"] for a in out if (a.get("facet") or {}).get("enabled")]
        print(f"{path.relative_to(ROOT)}: {len(out)} attrs, {len(enabled)} facets → {enabled}")


if __name__ == "__main__":
    main()
