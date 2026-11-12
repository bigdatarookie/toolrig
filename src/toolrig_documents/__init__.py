"""Read-only, bounded document operations shared by the CLI and MCP server."""

from .service import extract_tables, inspect_document, read_document, render_document

__all__ = ["inspect_document", "read_document", "render_document", "extract_tables"]
