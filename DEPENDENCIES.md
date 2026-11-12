# Document service dependency inventory

Inventory date: 2026-11-12. Python dependencies are exact-pinned in `pyproject.toml` and resolved in `uv.lock`.

| Component | Pin | License | Platform/source notes |
|---|---:|---|---|
| Python | 3.11+ | PSF | MCP SDK 2.x and pdfminer.six require Python 3.10+; this package standardizes on 3.11+. |
| MCP Python SDK | 2.3.0 | MIT | Python 3.10+; official SDK documents stdio and Streamable HTTP transports. |
| pdfplumber | 0.11.10 | MIT | Pure Python wheel; project documents support on Python 3.10–3.14. Best suited to machine-generated PDFs. |
| pdfminer.six | 20260107 | MIT | Pure Python; Python 3.10+. Used by pdfplumber. |
| python-docx | 1.2.0 | MIT | Pure Python wheel, Python 3.9+; reads DOCX without launching Office. |
| openpyxl | 3.1.5 | MIT | Python 3.8+; reads XLSX. It does not calculate formulas; `data_only` reads cached results if present. |
| Pillow | 13.0.0 | MIT-CMU | Python 3.10+; PyPI publishes macOS ARM64 and Linux x86-64/ARM64 wheels. |
| pytesseract | 0.3.13 | Apache-2.0 | Python wrapper only. The separately installed Tesseract executable and language data are required for OCR. |
| defusedxml | 0.7.1 | PSF | Explicit XML hardening dependency for untrusted spreadsheet packages. |
| pytest (dev) | 8.4.2 | MIT | Test runner. |
| ReportLab (dev) | 5.1.0 | BSD-3-Clause | Generates small deterministic fixtures only; not a runtime dependency. |
| Poppler utilities | system package; runtime-reported | GPL-2.0-or-later components | `pdftotext` and `pdftoppm` are optional system executables. PDF extraction falls back to pdfplumber; rendering needs `pdftoppm`. |
| Tesseract OCR | system package; runtime-reported | Apache-2.0 | Optional executable plus installed trained language data. OCR is invoked only for scanned PDF/image input or an explicit OCR request. |
| OCRmyPDF | not installed / not pinned | MPL-2.0 | Not needed for the supported read/inspect/render/extract operations: it produces a searchable PDF, which this read-only service does not request. |

## Runtime inventory

Observed on the authoring host: macOS 26.3, arm64, system Python 3.9.6, separate Python 3.11 at `/Users/garry/.local/bin/python3.11`, and uv available. The system Python is below this project's supported floor. Before installing this package, no `pdftotext`, `pdftoppm`, `pdfinfo`, `tesseract`, or `ocrmypdf` executable was on PATH. System Python had openpyxl 3.1.5 and Pillow 11.3.0; those are not the isolated package environment.

This checkout can verify Python-library operations under Python 3.11. Native Poppler rendering and Tesseract OCR are unavailable until those system tools are installed; end-to-end native render/OCR smoke results must stay NOT RUN here. Linux was not available on the authoring host; Linux is represented in CI, not locally smoke-tested.

## Primary sources

- [MCP SDK PyPI metadata and official SDK docs](https://pypi.org/project/mcp/), [SDK first steps](https://py.sdk.modelcontextprotocol.io/get-started/first-steps/)
- [pdfplumber PyPI and project docs](https://pypi.org/project/pdfplumber/)
- [pdfminer.six PyPI](https://pypi.org/project/pdfminer.six/)
- [python-docx PyPI](https://pypi.org/project/python-docx/)
- [openpyxl PyPI](https://pypi.org/project/openpyxl/), [openpyxl usage documentation](https://openpyxl.readthedocs.io/en/stable/usage.html)
- [Pillow PyPI](https://pypi.org/project/pillow/)
- [pytesseract project and license](https://github.com/madmaze/pytesseract)
- [Tesseract installation and license](https://github.com/tesseract-ocr/tessdoc/blob/main/Installation.md), [Tesseract upstream](https://github.com/tesseract-ocr/tesseract)
- [Poppler upstream README](https://gitlab.freedesktop.org/poppler/poppler/-/blob/master/README.md), [pdftotext manual](https://manpages.debian.org/testing/poppler-utils/pdftotext.1.en.html), [pdftoppm manual](https://manpages.debian.org/unstable/poppler-utils/pdftoppm.1.en.html)
- [OCRmyPDF PyPI metadata and installation](https://pypi.org/project/ocrmypdf/)
- [defusedxml PyPI](https://pypi.org/project/defusedxml/), [ReportLab open source docs](https://docs.reportlab.com/developerfaqs/)

Version and license claims above were checked against package metadata or upstream project documentation on the inventory date. Runtime Poppler/Tesseract versions remain unknown because neither executable was installed.
