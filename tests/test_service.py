from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from toolrig_documents import extract_tables, inspect_document, read_document, render_document
from toolrig_documents import service
from toolrig_documents.mcp_server import mcp

FIXTURES = Path(__file__).parent / "fixtures"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_pdf_inspect_and_bounded_text_with_page_references():
    source = FIXTURES / "text.pdf"
    result = read_document(source, pages="2")
    assert result["ok"] is True
    assert result["data"][0]["page"] == 2
    assert "Page two" in result["data"][0]["text"]
    assert result["source_refs"] == [{"page": 2}]
    assert inspect_document(source)["data"]["pages"] == 2


def test_pdf_page_selection_is_bounded_and_validated():
    source = FIXTURES / "text.pdf"
    invalid = read_document(source, pages="3")
    assert invalid["ok"] is False
    assert invalid["error"]["code"] == "range_out_of_bounds"
    too_many = render_document(FIXTURES / "table.pdf", pages="1-10")
    assert too_many["error"]["code"] in {"range_limit_exceeded", "range_out_of_bounds"}
    with pytest.raises(service.DocumentError, match="At most 10 pages"):
        service._pages("1-11", 11)


def test_pdf_table_extraction_has_page_and_table_provenance():
    result = extract_tables(FIXTURES / "table.pdf", pages="1")
    assert result["ok"] is True
    assert result["data"]["tables"]
    rows = result["data"]["tables"][0]["rows"]
    assert rows[0] == ["Item", "Units"]
    assert result["source_refs"] == [{"page": 1, "table": 1}]


def test_docx_table_and_source_refs():
    result = read_document(FIXTURES / "sample.docx")
    assert result["ok"] is True
    assert result["data"]["paragraphs"] == ["Document summary"]
    assert result["data"]["tables"][0]["rows"] == [["Region", "Count"], ["North", "6"]]
    assert result["source_refs"] == [{"kind": "paragraph", "index": 1}, {"kind": "table", "index": 1}]


def test_xlsx_exposes_formula_cached_value_and_range():
    result = read_document(FIXTURES / "sample.xlsx", sheet="Summary", cell_range="B2:B3")
    assert result["ok"] is True
    by_cell = {cell["cell"]: cell for cell in result["data"]["cells"]}
    assert by_cell["B2"]["value"] == 42
    assert by_cell["B2"]["formula"] is None
    assert by_cell["B3"]["formula"] == "=B2*2"
    assert by_cell["B3"]["cached_value"] == 84
    assert by_cell["B3"]["value_source"] == "cached_formula_result"
    assert any(warning["code"] == "formula_values_not_calculated" for warning in result["warnings"])
    out_of_bounds = read_document(FIXTURES / "sample.xlsx", sheet="Summary", cell_range="A1:ZZ5000")
    assert out_of_bounds["error"]["code"] == "range_limit_exceeded"


def test_csv_bom_quoting_and_row_selection():
    result = read_document(FIXTURES / "sample.csv", row_range="2:2")
    assert result["ok"] is True
    assert result["data"]["rows"] == [["Ada", "hello, world"]]
    assert result["source_refs"] == [{"row": 2}]


def test_scanned_document_triggers_ocr_and_marks_uncertainty(monkeypatch, tmp_path):
    rendered_copy = tmp_path / "rendered.png"
    shutil.copyfile(FIXTURES / "scanned.png", rendered_copy)
    monkeypatch.setattr(service, "_pdf_render", lambda source, page, dpi=120: rendered_copy)
    monkeypatch.setattr(service, "_ocr_image", lambda image: (
        "invoice total 1842", 68.0,
        [{"code": "ocr_uncertain", "message": "OCR is approximate."}, {"code": "low_ocr_confidence", "message": "Low."}],
    ))
    result = read_document(FIXTURES / "scanned.pdf", pages="1")
    assert result["ok"] is True
    assert result["data"][0]["ocr_used"] is True
    assert result["data"][0]["ocr_mean_confidence"] == 68.0
    assert "ocr_uncertain" in {warning["code"] for warning in result["warnings"]}


def test_image_ocr_marks_uncertainty(monkeypatch):
    class FakeOutput:
        DICT = object()

    monkeypatch.setattr(service.pytesseract, "Output", FakeOutput)
    monkeypatch.setattr(service.pytesseract, "image_to_data", lambda image, output_type, timeout: {
        "text": ["Invoice", "1842"], "conf": ["91", "61"],
    })
    original_hash = sha256(FIXTURES / "scanned.png")
    result = read_document(FIXTURES / "scanned.png")
    assert result["ok"] is True
    assert result["data"]["text"] == "Invoice 1842"
    assert result["data"]["ocr_mean_confidence"] == 76
    assert result["warnings"][0]["code"] == "ocr_uncertain"
    assert sha256(FIXTURES / "scanned.png") == original_hash


def test_explicit_pdf_ocr_runs_even_with_text_layer(monkeypatch, tmp_path):
    rendered_copy = tmp_path / "rendered.png"
    shutil.copyfile(FIXTURES / "scanned.png", rendered_copy)
    monkeypatch.setattr(service, "_pdf_render", lambda source, page, dpi=120: rendered_copy)
    monkeypatch.setattr(service, "_ocr_image", lambda image: (
        "explicit OCR result", 90.0, [{"code": "ocr_uncertain", "message": "Estimate."}],
    ))
    result = read_document(FIXTURES / "text.pdf", pages="1", ocr=True)
    assert result["ok"] is True
    assert result["data"][0]["text"] == "explicit OCR result"
    assert result["data"][0]["ocr_used"] is True


def test_real_image_ocr_when_tesseract_is_installed():
    if not shutil.which("tesseract"):
        pytest.skip("Tesseract is not installed on this host.")
    result = read_document(FIXTURES / "scanned.png")
    assert result["ok"] is True
    assert "invoice" in result["data"]["text"].lower()
    assert any(warning["code"] == "ocr_uncertain" for warning in result["warnings"])


def test_ocr_reports_missing_native_dependency():
    if shutil.which("tesseract"):
        pytest.skip("Tesseract is available; the real OCR smoke covers this host.")
    result = read_document(FIXTURES / "scanned.png")
    assert result["ok"] is False
    assert result["error"]["code"] == "dependency_missing"


def test_original_files_remain_byte_identical():
    paths = [FIXTURES / name for name in (
        "text.pdf", "table.pdf", "scanned.pdf", "scanned.png", "sample.docx", "sample.xlsx", "sample.csv",
    )]
    before = {path: sha256(path) for path in paths}
    read_document(paths[0], pages="1")
    extract_tables(paths[1], pages="1")
    read_document(paths[2], pages="1", ocr=False)
    read_document(paths[3], ocr=False)
    read_document(paths[4])
    read_document(paths[5], sheet="Summary", cell_range="A1:B3")
    read_document(paths[6], row_range="1:3")
    assert {path: sha256(path) for path in paths} == before


def test_unsupported_and_missing_path_are_structured():
    unsupported = inspect_document(FIXTURES / "unrecognized.txt")
    assert unsupported["ok"] is False
    assert unsupported["status"] == "unsupported"
    assert unsupported["error"]["code"] == "unsupported_format"
    missing = read_document(FIXTURES / "missing.pdf")
    assert missing["ok"] is False
    assert missing["error"]["code"] == "file_not_found"


def test_render_reports_native_dependency_state():
    result = render_document(FIXTURES / "text.pdf", pages="1")
    if shutil.which("pdftoppm"):
        assert result["ok"] is True
        assert Path(result["data"]["artifacts"][0]["path"]).is_file()
    else:
        assert result["error"]["code"] == "dependency_missing"


def test_pdf_render_rejects_oversized_page_before_poppler_or_artifact(monkeypatch, tmp_path):
    monkeypatch.setenv("TOOLRIG_DOCUMENT_ARTIFACT_DIR", str(tmp_path))
    monkeypatch.setattr(service.shutil, "which", lambda name: "/fake/pdftoppm")
    called = False

    def unexpected_render(*args, **kwargs):
        nonlocal called
        called = True
        raise AssertionError("pdftoppm must not run for a page over the pixel bound")

    monkeypatch.setattr(service, "_run", unexpected_render)
    result = render_document(FIXTURES / "oversized-page.pdf", pages="1")
    assert result["ok"] is False
    assert result["error"]["code"] == "render_size_limit_exceeded"
    assert called is False
    assert list(tmp_path.iterdir()) == []


def test_pdf_render_rejects_oversized_png_before_artifact_copy(monkeypatch, tmp_path):
    monkeypatch.setenv("TOOLRIG_DOCUMENT_ARTIFACT_DIR", str(tmp_path))
    monkeypatch.setattr(service.shutil, "which", lambda name: "/fake/pdftoppm")

    def create_oversized_png(command, **kwargs):
        with Path(command[-1]).with_suffix(".png").open("wb") as artifact:
            artifact.truncate(service.MAX_RENDER_ARTIFACT_BYTES + 1)
        return subprocess.CompletedProcess(command, 0, b"", b"")

    monkeypatch.setattr(service, "_run", create_oversized_png)
    result = render_document(FIXTURES / "text.pdf", pages="1")
    assert result["ok"] is False
    assert result["error"]["code"] == "render_size_limit_exceeded"
    assert list(tmp_path.iterdir()) == []


def test_large_output_becomes_artifact_with_compact_preview(tmp_path, monkeypatch):
    monkeypatch.setenv("TOOLRIG_DOCUMENT_ARTIFACT_DIR", str(tmp_path))
    result = service._result("read", FIXTURES / "text.pdf", "x" * 25_000)
    assert len(json.dumps(result)) < 17_000
    assert result["artifact"]["uri"].startswith("artifact://document-result-")
    artifact_path = Path(result["artifact"]["path"])
    assert artifact_path.read_text(encoding="utf-8").find("x" * 20_000) >= 0


def test_cli_and_mcp_share_the_same_service_contract():
    path = str(FIXTURES / "text.pdf")
    cli = subprocess.run(
        [sys.executable, "-m", "toolrig_documents.cli", "read", path, "--pages", "2"],
        capture_output=True, text=True, check=True,
    )
    cli_result = json.loads(cli.stdout)

    async def call_mcp():
        from mcp import Client

        async with Client(mcp) as client:
            tools = await client.list_tools()
            assert {tool.name for tool in tools.tools} == {"inspect", "read", "render", "extract_tables"}
            return await client.call_tool("read", {"path": path, "pages": "2"})

    mcp_result = asyncio.run(call_mcp())
    structured = getattr(mcp_result, "structured_content", None) or getattr(mcp_result, "structuredContent", None)
    assert structured is not None
    assert cli_result["data"][0]["text"] == structured["data"][0]["text"]
    assert structured["source_refs"] == [{"page": 2}]
