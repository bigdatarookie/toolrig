from __future__ import annotations

import io
import zipfile
from pathlib import Path

from docx import Document
from openpyxl import Workbook
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.platypus import Table, TableStyle

FIXTURES = Path(__file__).parent / "fixtures"
FIXTURES.mkdir(parents=True, exist_ok=True)


def text_pdf() -> None:
    output = FIXTURES / "text.pdf"
    pdf = canvas.Canvas(str(output), pagesize=letter)
    pdf.drawString(72, 720, "Quarterly report")
    pdf.drawString(72, 690, "Revenue,42")
    pdf.showPage()
    pdf.drawString(72, 720, "Page two: bounded read works")
    pdf.save()


def oversized_pdf() -> None:
    output = FIXTURES / "oversized-page.pdf"
    pdf = canvas.Canvas(str(output), pagesize=(20_000, 20_000))
    pdf.drawString(72, 19_900, "Page exceeds the render pixel limit")
    pdf.save()


def table_pdf() -> None:
    output = FIXTURES / "table.pdf"
    pdf = canvas.Canvas(str(output), pagesize=letter)
    table = Table([["Item", "Units"], ["apples", "12"], ["pears", "7"]], colWidths=[180, 100])
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.7, colors.black),
        ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
    ]))
    table.wrapOn(pdf, 400, 300)
    table.drawOn(pdf, 72, 650)
    pdf.save()


def scanned_pdf() -> None:
    image_path = FIXTURES / "scanned.png"
    image = Image.new("RGB", (1400, 260), "white")
    draw = ImageDraw.Draw(image)
    draw.text((45, 65), "Scanned note: invoice total 1842", fill="black", font=ImageFont.load_default(size=64))
    image.save(image_path)
    output = FIXTURES / "scanned.pdf"
    pdf = canvas.Canvas(str(output), pagesize=letter)
    pdf.drawImage(ImageReader(str(image_path)), 48, 540, width=516, height=96, preserveAspectRatio=True)
    pdf.save()


def docx_fixture() -> None:
    document = Document()
    document.add_paragraph("Document summary")
    table = document.add_table(rows=1, cols=2)
    table.style = "Table Grid"
    table.rows[0].cells[0].text = "Region"
    table.rows[0].cells[1].text = "Count"
    row = table.add_row().cells
    row[0].text = "North"
    row[1].text = "6"
    document.save(FIXTURES / "sample.docx")


def xlsx_fixture() -> None:
    path = FIXTURES / "sample.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Summary"
    sheet.append(["Metric", "Value"])
    sheet.append(["Revenue", 42])
    sheet.append(["Next quarter", "=B2*2"])
    workbook.save(path)

    temporary = path.with_suffix(".tmp")
    with zipfile.ZipFile(path, "r") as source, zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as target:
        for item in source.infolist():
            contents = source.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                text = contents.decode("utf-8")
                text = text.replace("<f>B2*2</f><v></v>", "<f>B2*2</f><v>84</v>")
                contents = text.encode("utf-8")
            target.writestr(item, contents)
    temporary.replace(path)


def csv_fixture() -> None:
    (FIXTURES / "sample.csv").write_bytes(
        b"\xef\xbb\xbfName,Comment\nAda,\"hello, world\"\nLin,\"said \"\"yes\"\"\"\n"
    )


def unsupported_fixture() -> None:
    (FIXTURES / "unrecognized.txt").write_text("not a supported document format\n", encoding="utf-8")


if __name__ == "__main__":
    text_pdf()
    oversized_pdf()
    table_pdf()
    scanned_pdf()
    docx_fixture()
    xlsx_fixture()
    csv_fixture()
    unsupported_fixture()
