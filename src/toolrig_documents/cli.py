from __future__ import annotations

import argparse
import json
import sys
from typing import Sequence

from .service import extract_tables, inspect_document, read_document, render_document


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="toolrig-documents", description="Bounded, read-only document operations.")
    sub = parser.add_subparsers(dest="operation", required=True)
    inspect = sub.add_parser("inspect", help="Inspect format and basic document structure.")
    inspect.add_argument("path")
    read = sub.add_parser("read", help="Read text, rows, cells, or explicit OCR output.")
    read.add_argument("path")
    read.add_argument("--pages")
    read.add_argument("--sheet")
    read.add_argument("--cell-range")
    read.add_argument("--row-range")
    read.add_argument("--ocr", dest="ocr", action="store_true", default=None)
    read.add_argument("--no-ocr", dest="ocr", action="store_false", default=None)
    read.add_argument("--no-formulas", dest="include_formulas", action="store_false", default=True)
    render = sub.add_parser("render", help="Render selected PDF pages to task-owned PNG artifacts.")
    render.add_argument("path")
    render.add_argument("--pages")
    render.add_argument("--dpi", type=int, default=120)
    tables = sub.add_parser("extract-tables", help="Extract tables from a bounded document range.")
    tables.add_argument("path")
    tables.add_argument("--pages")
    tables.add_argument("--sheet")
    tables.add_argument("--cell-range")
    tables.add_argument("--row-range")
    return parser


def dispatch(args: argparse.Namespace) -> dict:
    values = vars(args).copy()
    operation = values.pop("operation")
    path = values.pop("path")
    if operation == "inspect":
        return inspect_document(path)
    if operation == "read":
        return read_document(path, **values)
    if operation == "render":
        return render_document(path, **values)
    return extract_tables(path, **values)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    result = dispatch(args)
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
