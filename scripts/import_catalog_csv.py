#!/usr/bin/env python3
"""
Convert one or more catalog CSV files into static JSON responses that can be
served by a simple static web server (e.g. python -m http.server).

The frontend expects:
  GET /api/public/catalog/<catalog>/<brand>
to return JSON like:
  {"success": true, "data": [...]}

We generate exactly those files on disk under:
  api/public/catalog/<catalog>/<brand>

Usage:
  python3 scripts/import_catalog_csv.py \
    --brand arquati \
    sistema-ibrido=./catalog_csv/sistema-ibrido.csv \
    pompa-calore=./catalog_csv/pompa-calore.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


def _normalize_key(raw: str) -> str:
    s = (raw or "").strip().lower()
    if not s:
        return ""
    # Strip accents/diacritics to maximize header matching and keep ASCII keys.
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return s.strip("_")


def _choose_delimiter(sample: str) -> str:
    # Prefer Sniffer, but keep a deterministic fallback.
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=";,\t|")
        return dialect.delimiter
    except Exception:
        pass

    first_line = sample.splitlines()[0] if sample else ""
    candidates = [";", ",", "\t", "|"]
    # Pick the delimiter that produces the most columns (>=2), else default to ';'.
    best = ";"
    best_cols = 1
    for d in candidates:
        cols = len(first_line.split(d))
        if cols > best_cols:
            best_cols = cols
            best = d
    return best


def _open_text_with_fallback(path: Path):
    try:
        return path.open("r", encoding="utf-8-sig", newline="")
    except UnicodeDecodeError:
        return path.open("r", encoding="latin-1", newline="")


@dataclass(frozen=True)
class CatalogImport:
    catalog: str
    csv_path: Path


def _parse_catalog_specs(args: list[str]) -> list[CatalogImport]:
    specs: list[CatalogImport] = []
    for a in args:
        if "=" not in a:
            raise ValueError(f"Invalid mapping '{a}'. Expected CATALOG=CSV_PATH.")
        catalog, csv_path = a.split("=", 1)
        catalog = catalog.strip()
        csv_path = csv_path.strip()
        if not catalog:
            raise ValueError(f"Invalid mapping '{a}': empty catalog.")
        if not csv_path:
            raise ValueError(f"Invalid mapping '{a}': empty CSV path.")
        specs.append(CatalogImport(catalog=catalog, csv_path=Path(csv_path)))
    return specs


def _dedupe_key(existing: set[str], key: str) -> str:
    if key not in existing:
        existing.add(key)
        return key
    i = 2
    while f"{key}_{i}" in existing:
        i += 1
    out = f"{key}_{i}"
    existing.add(out)
    return out


def _iter_models_from_csv(csv_path: Path) -> Iterable[dict]:
    with _open_text_with_fallback(csv_path) as f:
        sample = f.read(4096)
        f.seek(0)
        delimiter = _choose_delimiter(sample)
        reader = csv.DictReader(f, delimiter=delimiter)

        if reader.fieldnames is None:
            return []

        # Normalize headers to snake_case-ish keys.
        seen: set[str] = set()
        header_map: dict[str, str] = {}
        for raw_h in reader.fieldnames:
            nk = _normalize_key(raw_h)
            if not nk:
                continue
            nk = _dedupe_key(seen, nk)
            header_map[raw_h] = nk

        models: list[dict] = []
        for row in reader:
            fields: dict[str, str] = {}
            for raw_h, raw_v in row.items():
                nk = header_map.get(raw_h)
                if not nk:
                    continue
                v = (raw_v or "").strip()
                if v == "":
                    continue
                fields[nk] = v

            if not fields:
                continue

            # A stable label improves the dropdown UX; fall back to common fields.
            label = (
                fields.get("label")
                or fields.get("modello")
                or fields.get("nome_commerciale")
                or fields.get("pdc_modello")
                or fields.get("denominazione")
            )

            models.append({"label": label, "fields": fields})

        return models


def _write_catalog_json(out_root: Path, catalog: str, brand: str, models: list[dict]) -> Path:
    out_dir = out_root / catalog
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / brand  # intentionally extensionless (matches frontend URL)
    payload = {"success": True, "data": models}
    out_path.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    return out_path


def main() -> int:
    ap = argparse.ArgumentParser(description="Import catalog CSVs into static /api/public/catalog responses.")
    ap.add_argument("--brand", default="arquati", help="Brand slug used in URL (default: arquati).")
    ap.add_argument(
        "--out-root",
        default="api/public/catalog",
        help="Output root directory (default: api/public/catalog).",
    )
    ap.add_argument(
        "catalog_csv",
        nargs="+",
        help="One or more mappings in the form CATALOG=CSV_PATH.",
    )
    ns = ap.parse_args()

    out_root = Path(ns.out_root)
    brand = str(ns.brand).strip()
    if not brand:
        ap.error("--brand cannot be empty.")

    try:
        specs = _parse_catalog_specs(ns.catalog_csv)
    except ValueError as e:
        ap.error(str(e))
        return 2

    wrote: list[Path] = []
    for spec in specs:
        csv_path = spec.csv_path
        if not csv_path.exists():
            ap.error(f"CSV not found: {csv_path}")
        models = list(_iter_models_from_csv(csv_path))
        wrote.append(_write_catalog_json(out_root, spec.catalog, brand, models))

    # Small, machine-friendly output for CI/scripts.
    for p in wrote:
        print(str(p))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

