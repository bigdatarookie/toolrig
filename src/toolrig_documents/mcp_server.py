from __future__ import annotations

from typing import Any

from mcp.server import MCPServer

from .service import extract_tables as _extract_tables
from .service import inspect_document, read_document, render_document

mcp = MCPServer("Toolrig documents")


@mcp.tool()
def inspect(path: str) -> dict[str, Any]:
    """Inspect a supported document's format and basic structure."""
    return inspect_document(path)


@mcp.tool()
def read(path: str, pages: str | None = None, sheet: str | None = None,
         cell_range: str | None = None, row_range: str | None = None,
         ocr: bool | None = None, include_formulas: bool = True) -> dict[str, Any]:
    """Read a bounded page, worksheet, cell, or row range; OCR is used only when needed or requested."""
    return read_document(path, pages=pages, sheet=sheet, cell_range=cell_range,
                         row_range=row_range, ocr=ocr, include_formulas=include_formulas)


@mcp.tool()
def render(path: str, pages: str | None = None, dpi: int = 120) -> dict[str, Any]:
    """Render up to five selected PDF pages to task-owned PNG artifacts."""
    return render_document(path, pages=pages, dpi=dpi)


@mcp.tool()
def extract_tables(path: str, pages: str | None = None, sheet: str | None = None,
                   cell_range: str | None = None, row_range: str | None = None) -> dict[str, Any]:
    """Extract tables from selected PDF pages, a DOCX, or a bounded spreadsheet/CSV range."""
    return _extract_tables(path, pages=pages, sheet=sheet, cell_range=cell_range, row_range=row_range)


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
