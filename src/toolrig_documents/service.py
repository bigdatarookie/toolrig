from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Any

import pdfplumber
import pytesseract
from docx import Document
from openpyxl import load_workbook
from openpyxl.utils.cell import range_boundaries
from PIL import Image

MAX_PAGES = 10
MAX_ROWS = 500
MAX_CELLS = 5_000
MAX_OUTPUT_BYTES = 16_000
MAX_PREVIEW_CHARS = 8_000
MAX_INPUT_BYTES = 100 * 1024 * 1024
SUPPORTED = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".docx", ".xlsx", ".csv"}
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".tif", ".tiff"}


class DocumentError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _result(operation: str, source: Path, data: Any = None, *, warnings: list[dict] | None = None,
            refs: list[dict] | None = None) -> dict:
    answer = {
        "ok": True,
        "status": "ok",
        "operation": operation,
        "source": {"name": source.name, "format": source.suffix.lower().lstrip(".")},
        "data": data,
        "source_refs": refs or [],
        "warnings": warnings or [],
    }
    return _bound_result(answer)


def _error(operation: str, path: str | Path, code: str, message: str) -> dict:
    try:
        name = Path(path).name
    except (OSError, RuntimeError, TypeError, ValueError):
        name = ""
    return {
        "ok": False,
        "status": "unsupported" if code == "unsupported_format" else "error",
        "operation": operation,
        "source": {"name": name, "format": Path(name).suffix.lower().lstrip(".")},
        "data": None,
        "source_refs": [],
        "warnings": [],
        "error": {"code": code, "message": message},
    }


def _bound_result(answer: dict) -> dict:
    encoded = json.dumps(answer, ensure_ascii=False, default=str).encode("utf-8")
    if len(encoded) <= MAX_OUTPUT_BYTES:
        return answer
    artifact = _write_artifact(encoded, ".json", "document-result")
    answer["data"] = {"preview": encoded[:MAX_PREVIEW_CHARS].decode("utf-8", errors="ignore"), "truncated": True}
    answer["artifact"] = artifact
    answer["warnings"].append({
        "code": "output_truncated",
        "message": "Full output is in the task-owned artifact; the inline result is a bounded preview.",
    })
    return answer


def _artifact_root() -> Path:
    configured = os.environ.get("TOOLRIG_DOCUMENT_ARTIFACT_DIR", ".toolrig-artifacts")
    root = Path(configured).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _write_artifact(data: bytes, suffix: str, prefix: str) -> dict:
    root = _artifact_root()
    name = f"{prefix}-{uuid.uuid4().hex[:12]}{suffix}"
    target = root / name
    target.write_bytes(data)
    return {"uri": f"artifact://{name}", "path": str(target), "bytes": len(data)}


def _source(path: str | Path, operation: str) -> Path:
    try:
        source = Path(path).expanduser().resolve()
    except (TypeError, ValueError):
        raise DocumentError("invalid_path", "A valid document path is required.")
    suffix = source.suffix.lower()
    if suffix not in SUPPORTED:
        raise DocumentError("unsupported_format", f"Format '{suffix or '(no extension)'}' is not supported.")
    if not source.exists() or not source.is_file():
        raise DocumentError("file_not_found", "The requested document is not a readable file.")
    if source.stat().st_size > MAX_INPUT_BYTES:
        raise DocumentError("input_too_large", f"Documents larger than {MAX_INPUT_BYTES // (1024 * 1024)} MiB are not supported.")
    return source


def _run(command: list[str], *, timeout: int = 60, input_data: bytes | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(command, input=input_data, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError:
        raise DocumentError("dependency_missing", f"Required executable '{command[0]}' is not installed or not on PATH.")
    except subprocess.TimeoutExpired:
        raise DocumentError("operation_timeout", f"'{command[0]}' exceeded the {timeout}-second operation limit.")


def _pages(selection: str | None, total: int, limit: int = MAX_PAGES) -> list[int]:
    if total < 1:
        raise DocumentError("invalid_document", "The document has no pages.")
    if not selection:
        values = list(range(1, min(total, 5) + 1))
    else:
        values = []
        for part in selection.split(","):
            piece = part.strip()
            match = re.fullmatch(r"(\d+)(?:\s*-\s*(\d+))?", piece)
            if not match:
                raise DocumentError("invalid_range", "Page selection must use values such as '1,3-5'.")
            first = int(match.group(1))
            last = int(match.group(2) or first)
            if first < 1 or last < first or last > total:
                raise DocumentError("range_out_of_bounds", f"Page selection must be between 1 and {total}.")
            values.extend(range(first, last + 1))
    if len(set(values)) > limit:
        raise DocumentError("range_limit_exceeded", f"At most {limit} pages may be requested at once.")
    return list(dict.fromkeys(values))


def _row_bounds(selection: str | None, max_rows: int = MAX_ROWS) -> tuple[int, int]:
    if not selection:
        return 1, min(200, max_rows)
    match = re.fullmatch(r"\s*(\d+)\s*:\s*(\d+)\s*", selection)
    if not match:
        raise DocumentError("invalid_range", "Row range must use 'first:last', for example '1:20'.")
    first, last = map(int, match.groups())
    if first < 1 or last < first:
        raise DocumentError("invalid_range", "Row range must use positive, increasing row numbers.")
    if last - first + 1 > max_rows:
        raise DocumentError("range_limit_exceeded", f"At most {max_rows} rows may be requested at once.")
    return first, last


def _pdf_page_count(source: Path) -> int:
    try:
        with pdfplumber.open(source) as pdf:
            return len(pdf.pages)
    except Exception as exc:
        text = str(exc).lower()
        if "password" in text or "encrypt" in text:
            raise DocumentError("password_required", "This PDF is encrypted. Raw passwords are not accepted by this service.")
        raise DocumentError("invalid_document", "PDF could not be opened.")


def _pdf_text(source: Path, page: int) -> tuple[str, list[dict]]:
    executable = shutil.which("pdftotext")
    if executable:
        proc = _run([executable, "-f", str(page), "-l", str(page), "-layout", str(source), "-"])
        if proc.returncode == 0:
            return proc.stdout.decode("utf-8", errors="replace"), []
        if b"password" in proc.stderr.lower() or b"encrypted" in proc.stderr.lower():
            raise DocumentError("password_required", "This PDF is encrypted. Raw passwords are not accepted by this service.")
        raise DocumentError("pdf_read_failed", "Poppler could not extract text from this PDF page.")
    try:
        with pdfplumber.open(source) as pdf:
            return pdf.pages[page - 1].extract_text(layout=False) or "", [
                {"code": "poppler_unavailable", "message": "pdftotext is unavailable; pdfplumber fallback was used."}
            ]
    except Exception as exc:
        if "password" in str(exc).lower() or "encrypt" in str(exc).lower():
            raise DocumentError("password_required", "This PDF is encrypted. Raw passwords are not accepted by this service.")
        raise DocumentError("pdf_read_failed", "PDF page text could not be extracted.")


def _pdf_render(source: Path, page: int, dpi: int = 120) -> Path:
    executable = shutil.which("pdftoppm")
    if not executable:
        raise DocumentError("dependency_missing", "Poppler pdftoppm is required for PDF rendering.")
    temp = Path(tempfile.mkdtemp(prefix="toolrig-doc-page-"))
    prefix = temp / "page"
    try:
        proc = _run([
            executable, "-f", str(page), "-l", str(page), "-r", str(dpi), "-png", "-singlefile",
            str(source), str(prefix),
        ])
    except DocumentError:
        shutil.rmtree(temp, ignore_errors=True)
        raise
    rendered = prefix.with_suffix(".png")
    if proc.returncode != 0 or not rendered.is_file():
        shutil.rmtree(temp, ignore_errors=True)
        raise DocumentError("render_failed", "Poppler could not render the selected PDF page.")
    return rendered


def _ocr_image(image_path: Path) -> tuple[str, float | None, list[dict]]:
    try:
        with Image.open(image_path) as image:
            details = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT, timeout=60)
    except pytesseract.TesseractNotFoundError:
        raise DocumentError("dependency_missing", "Tesseract is required for OCR and is not installed or not on PATH.")
    except pytesseract.TesseractError:
        raise DocumentError("ocr_failed", "Tesseract could not recognize text in the selected image.")
    except RuntimeError:
        raise DocumentError("operation_timeout", "Tesseract exceeded the 60-second OCR limit.")
    tokens: list[str] = []
    confidences: list[float] = []
    for token, raw_conf in zip(details.get("text", []), details.get("conf", [])):
        token = token.strip()
        try:
            confidence = float(raw_conf)
        except (TypeError, ValueError):
            confidence = -1
        if token and confidence >= 0:
            tokens.append(token)
            confidences.append(confidence)
    text = " ".join(tokens)
    mean = sum(confidences) / len(confidences) if confidences else None
    warnings = [{
        "code": "ocr_uncertain",
        "message": "OCR text is an estimate; compare it with the source image before relying on exact values.",
    }]
    if mean is not None and mean < 75:
        warnings.append({"code": "low_ocr_confidence", "message": "Mean Tesseract word confidence is below 75."})
    return text, mean, warnings


def _docx_content(source: Path, want_tables: bool = True) -> tuple[list[str], list[dict], list[dict]]:
    try:
        document = Document(source)
    except Exception:
        raise DocumentError("invalid_document", "DOCX could not be opened.")
    content: list[str] = []
    tables: list[dict] = []
    refs: list[dict] = []
    paragraph_index = 0
    table_index = 0
    for item in document.iter_inner_content():
        if hasattr(item, "text"):
            paragraph_index += 1
            value = item.text.strip()
            if value:
                content.append(value)
                refs.append({"kind": "paragraph", "index": paragraph_index})
        elif want_tables:
            table_index += 1
            rows = [[cell.text.strip() for cell in row.cells] for row in item.rows]
            tables.append({"table": table_index, "rows": rows})
            refs.append({"kind": "table", "index": table_index})
    return content, tables, refs


def _xlsx_cells(source: Path, sheet: str | None, cell_range: str | None,
                include_formulas: bool = True) -> tuple[list[dict], list[dict]]:
    if source.suffix.lower() != ".xlsx":
        raise DocumentError("unsupported_format", "Only .xlsx spreadsheets are supported; macro-enabled or legacy workbooks are not opened.")
    try:
        formulas = load_workbook(source, read_only=True, data_only=False, keep_links=False)
        cached = load_workbook(source, read_only=True, data_only=True, keep_links=False)
    except Exception as exc:
        if "password" in str(exc).lower() or zipfile.is_zipfile(source) is False:
            raise DocumentError("invalid_document", "Workbook could not be opened as a valid XLSX file.")
        raise DocumentError("invalid_document", "Workbook could not be opened.")
    try:
        if sheet:
            if sheet not in formulas.sheetnames:
                raise DocumentError("sheet_not_found", f"Worksheet '{sheet}' does not exist.")
            names = [sheet]
        else:
            names = formulas.sheetnames[:5]
        cells: list[dict] = []
        refs: list[dict] = []
        for name in names:
            form_ws = formulas[name]
            cache_ws = cached[name]
            if cell_range:
                try:
                    min_col, min_row, max_col, max_row = range_boundaries(cell_range)
                except (TypeError, ValueError):
                    raise DocumentError("invalid_range", "Cell range must be an A1 range such as 'A1:C20'.")
                if None in (min_col, min_row, max_col, max_row) or min_col < 1 or min_row < 1:
                    raise DocumentError("invalid_range", "Cell range must be a bounded A1 range such as 'A1:C20'.")
                if (max_col - min_col + 1) * (max_row - min_row + 1) > MAX_CELLS:
                    raise DocumentError("range_limit_exceeded", f"At most {MAX_CELLS} cells may be requested at once.")
            else:
                min_col, min_row = 1, 1
                max_col, max_row = min(max(form_ws.max_column, 1), 20), min(max(form_ws.max_row, 1), MAX_ROWS)
            for row in form_ws.iter_rows(min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col):
                for formula_cell in row:
                    cached_value = cache_ws[formula_cell.coordinate].value
                    formula = formula_cell.value if isinstance(formula_cell.value, str) and formula_cell.value.startswith("=") else None
                    value = cached_value if formula else formula_cell.value
                    cell = {
                        "sheet": name,
                        "cell": formula_cell.coordinate,
                        "value": value,
                    }
                    if include_formulas:
                        cell["formula"] = formula
                        cell["cached_value"] = cached_value if formula else None
                        cell["value_source"] = "cached_formula_result" if formula else "cell_value"
                    if value is not None or formula is not None:
                        cells.append(cell)
                        refs.append({"sheet": name, "cell": formula_cell.coordinate})
        return cells, refs
    finally:
        formulas.close()
        cached.close()


def _csv_rows(source: Path, row_range: str | None) -> tuple[list[list[str]], list[dict]]:
    first, last = _row_bounds(row_range)
    rows: list[list[str]] = []
    refs: list[dict] = []
    try:
        with source.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle)
            for row_number, row in enumerate(reader, start=1):
                if row_number > last:
                    break
                if row_number >= first:
                    rows.append(row)
                    refs.append({"row": row_number})
    except UnicodeDecodeError:
        raise DocumentError("encoding_unsupported", "CSV must be UTF-8 or UTF-8 with BOM.")
    except csv.Error:
        raise DocumentError("invalid_document", "CSV syntax is malformed.")
    return rows, refs


def inspect_document(path: str | Path) -> dict:
    operation = "inspect"
    try:
        source = _source(path, operation)
        details: dict[str, Any] = {"size_bytes": source.stat().st_size}
        warnings: list[dict] = []
        suffix = source.suffix.lower()
        if suffix == ".pdf":
            details["pages"] = _pdf_page_count(source)
        elif suffix in IMAGE_TYPES:
            try:
                with Image.open(source) as image:
                    details.update({"width": image.width, "height": image.height, "image_format": image.format})
            except Exception:
                raise DocumentError("invalid_document", "Image could not be opened.")
        elif suffix == ".docx":
            paragraphs, tables, refs = _docx_content(source)
            details.update({"paragraphs_with_text": len(paragraphs), "tables": len(tables)})
        elif suffix == ".xlsx":
            try:
                workbook = load_workbook(source, read_only=True, data_only=False, keep_links=False)
                details["sheets"] = workbook.sheetnames
                workbook.close()
            except Exception:
                raise DocumentError("invalid_document", "Workbook could not be opened as a valid XLSX file.")
        elif suffix == ".csv":
            details["encoding"] = "UTF-8 (BOM accepted)"
            details["delimiter"] = ","
        return _result(operation, source, details, warnings=warnings)
    except DocumentError as exc:
        return _error(operation, path, exc.code, str(exc))
    except OSError:
        return _error(operation, path, "read_failed", "Document could not be read.")


def read_document(path: str | Path, *, pages: str | None = None, sheet: str | None = None,
                  cell_range: str | None = None, row_range: str | None = None,
                  ocr: bool | None = None, include_formulas: bool = True) -> dict:
    operation = "read"
    warnings: list[dict] = []
    refs: list[dict] = []
    try:
        source = _source(path, operation)
        suffix = source.suffix.lower()
        if suffix == ".pdf":
            total = _pdf_page_count(source)
            selected = _pages(pages, total)
            page_data = []
            for page in selected:
                text, page_warnings = _pdf_text(source, page)
                warnings.extend(page_warnings)
                did_ocr = False
                confidence = None
                should_ocr = ocr is True or (ocr is None and len(text.strip()) < 3)
                if should_ocr:
                    rendered = _pdf_render(source, page)
                    try:
                        ocr_text, confidence, ocr_warnings = _ocr_image(rendered)
                        warnings.extend(ocr_warnings)
                        did_ocr = bool(ocr_text.strip())
                        if ocr_text.strip() or not text.strip():
                            text = ocr_text
                    finally:
                        shutil.rmtree(rendered.parent, ignore_errors=True)
                page_data.append({"page": page, "text": text, "ocr_used": did_ocr, "ocr_mean_confidence": confidence})
                refs.append({"page": page})
            if any(item["ocr_used"] for item in page_data):
                warnings.insert(0, {"code": "ocr_is_estimated", "message": "OCR output is approximate and may misread text or numbers."})
            return _result(operation, source, page_data, warnings=warnings, refs=refs)
        if suffix in IMAGE_TYPES:
            if ocr is False:
                return _result(operation, source, {"ocr_used": False, "message": "Image text extraction was not requested."})
            text, confidence, warnings = _ocr_image(source)
            return _result(operation, source, {"text": text, "ocr_used": True, "ocr_mean_confidence": confidence},
                           warnings=warnings, refs=[{"image": source.name}])
        if suffix == ".docx":
            paragraphs, tables, refs = _docx_content(source)
            return _result(operation, source, {"paragraphs": paragraphs, "tables": tables}, refs=refs)
        if suffix == ".xlsx":
            cells, refs = _xlsx_cells(source, sheet, cell_range, include_formulas)
            warnings.append({"code": "formula_values_not_calculated", "message": "openpyxl does not recalculate formulas; cached results may be absent or stale."})
            return _result(operation, source, {"cells": cells}, warnings=warnings, refs=refs)
        if suffix == ".csv":
            rows, refs = _csv_rows(source, row_range)
            return _result(operation, source, {"rows": rows}, refs=refs)
        raise DocumentError("unsupported_format", f"Read is not supported for '{suffix}'.")
    except DocumentError as exc:
        return _error(operation, path, exc.code, str(exc))
    except OSError:
        return _error(operation, path, "read_failed", "Document could not be read.")


def render_document(path: str | Path, *, pages: str | None = None, dpi: int = 120) -> dict:
    operation = "render"
    try:
        source = _source(path, operation)
        if source.suffix.lower() != ".pdf":
            raise DocumentError("unsupported_format", "Render currently supports PDF pages only.")
        if not 36 <= dpi <= 300:
            raise DocumentError("invalid_argument", "DPI must be between 36 and 300.")
        total = _pdf_page_count(source)
        selected = _pages(pages, total, limit=5)
        artifacts = []
        refs = []
        for page in selected:
            rendered = _pdf_render(source, page, dpi)
            try:
                artifact = _write_artifact(rendered.read_bytes(), ".png", f"page-{page}")
            finally:
                shutil.rmtree(rendered.parent, ignore_errors=True)
            artifacts.append({"page": page, **artifact})
            refs.append({"page": page})
        return _result(operation, source, {"artifacts": artifacts, "dpi": dpi}, refs=refs)
    except DocumentError as exc:
        return _error(operation, path, exc.code, str(exc))
    except OSError:
        return _error(operation, path, "render_failed", "Selected PDF pages could not be rendered.")


def extract_tables(path: str | Path, *, pages: str | None = None, sheet: str | None = None,
                   cell_range: str | None = None, row_range: str | None = None) -> dict:
    operation = "extract_tables"
    warnings: list[dict] = []
    refs: list[dict] = []
    try:
        source = _source(path, operation)
        suffix = source.suffix.lower()
        tables: list[dict] = []
        if suffix == ".pdf":
            total = _pdf_page_count(source)
            selected = _pages(pages, total)
            with pdfplumber.open(source) as pdf:
                for page_num in selected:
                    page_tables = pdf.pages[page_num - 1].extract_tables() or []
                    for table_num, rows in enumerate(page_tables, start=1):
                        tables.append({"page": page_num, "table": table_num, "rows": rows})
                        refs.append({"page": page_num, "table": table_num})
            if not tables:
                warnings.append({"code": "no_tables_found", "message": "No table structure was detected on the selected pages."})
        elif suffix == ".docx":
            _, tables, refs = _docx_content(source)
        elif suffix == ".xlsx":
            cells, refs = _xlsx_cells(source, sheet, cell_range)
            by_sheet: dict[str, list[dict]] = {}
            for cell in cells:
                by_sheet.setdefault(cell["sheet"], []).append(cell)
            tables = [{"sheet": name, "cells": data} for name, data in by_sheet.items()]
            warnings.append({"code": "formula_values_not_calculated", "message": "openpyxl does not recalculate formulas; cached results may be absent or stale."})
        elif suffix == ".csv":
            rows, refs = _csv_rows(source, row_range)
            tables = [{"rows": rows}]
        else:
            raise DocumentError("unsupported_format", f"Table extraction is not supported for '{suffix}'.")
        return _result(operation, source, {"tables": tables}, warnings=warnings, refs=refs)
    except DocumentError as exc:
        return _error(operation, path, exc.code, str(exc))
    except OSError:
        return _error(operation, path, "read_failed", "Tables could not be extracted from the selected document range.")
