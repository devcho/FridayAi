"""Offline document authoring. Receives one JSON request and returns JSON on stdout."""
import base64
import io
import json
import re
import sys
import zipfile

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")


def plain(text):
    return re.sub(r"\*\*([^*]+)\*\*|`([^`]+)`", lambda m: m.group(1) or m.group(2), text)


def blocks(content):
    lines = content.splitlines()
    result = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if re.fullmatch(r"[-*_]{3,}", line):
            i += 1
            continue
        if "|" in line and i + 1 < len(lines) and re.match(r"^[\s|:\-]+$", lines[i + 1]) and "-" in lines[i + 1]:
            rows = [[plain(cell.strip()) for cell in line.strip("|").split("|")]]
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append([plain(cell.strip()) for cell in lines[i].strip().strip("|").split("|")])
                i += 1
            if len(rows) > 500 or max(map(len, rows)) > 30:
                raise ValueError("표는 500행·30열 이내로 작성해 주세요.")
            width = max(map(len, rows))
            result.append(("table", [row + [""] * (width - len(row)) for row in rows]))
            continue
        match = re.match(r"^(#{1,6})\s+(.+)$", line)
        if match:
            result.append(("heading", (len(match[1]), plain(match[2]))))
        elif re.match(r"^[-*•]\s+", line):
            result.append(("bullet", plain(re.sub(r"^[-*•]\s+", "", line))))
        else:
            result.append(("paragraph", plain(line)))
        i += 1
    return result


def make_docx(title, items):
    from docx import Document
    from docx.shared import Pt, Cm, RGBColor
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "맑은 고딕"
    normal.font.size = Pt(10.5)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), "맑은 고딕")
    normal.paragraph_format.space_after = Pt(7)
    for section in doc.sections:
        section.top_margin = section.bottom_margin = Cm(2)
        section.left_margin = section.right_margin = Cm(2.2)
    doc.add_heading(title, 0)
    for kind, value in items:
        if kind == "heading":
            doc.add_heading(value[1], min(3, value[0]))
        elif kind == "table":
            table = doc.add_table(rows=1, cols=len(value[0]))
            table.style = "Light Shading Accent 1"
            for j, text in enumerate(value[0]):
                table.rows[0].cells[j].text = text
            for values in value[1:]:
                for cell, text in zip(table.add_row().cells, values):
                    cell.text = text
            doc.add_paragraph()
        else:
            doc.add_paragraph(value, style="List Bullet" if kind == "bullet" else None)
    for paragraph in doc.paragraphs:
        for run in paragraph.runs:
            run.font.name = "맑은 고딕"
            run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), "맑은 고딕")
    footer = doc.sections[0].footer.paragraphs[0]
    footer.alignment = 2
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "PAGE")
    footer._p.append(field)
    stream = io.BytesIO()
    doc.save(stream)
    return stream.getvalue()


def cell_value(text):
    value = text.strip()
    if value.startswith("="):
        functions = re.findall(r"([A-Za-z_][A-Za-z_0-9.]*)\s*\(", value)
        permitted = {"SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "ROUND", "IF", "IFERROR", "ABS"}
        if any(name.upper() not in permitted for name in functions) or any(c in value for c in "[]!|@\\") or "http" in value.lower() or not re.fullmatch(r'[=A-Za-z0-9_.,:()+*/^%<>&\- $"\s]+', value):
            raise ValueError("외부 연결이나 지원하지 않는 수식입니다. SUM·AVERAGE·기본 사칙연산 등을 사용해 주세요.")
        return value
    numeric = value.replace(",", "")
    if re.fullmatch(r"-?\d+(\.\d+)?", numeric):
        return float(numeric) if "." in numeric else int(numeric)
    return value


def make_xlsx(title, items):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
    book = Workbook()
    sheet = book.active
    sheet.title = re.sub(r'[\\/*?:\[\]]', " ", title)[:31] or "문서"
    row = 1
    sheet.cell(row, 1, title).font = Font(name="맑은 고딕", size=18, bold=True, color="264D40")
    row += 2
    for kind, value in items:
        if kind == "table":
            for index, values in enumerate(value):
                for col, text in enumerate(values, 1):
                    cell = sheet.cell(row, col, cell_value(text))
                    cell.font = Font(name="맑은 고딕", size=11, bold=index == 0, color="FFFFFF" if index == 0 else "263B34")
                    cell.fill = PatternFill("solid", fgColor="526F5E" if index == 0 else "F0F4EF" if index % 2 else "FFFFFF")
                    cell.alignment = Alignment(vertical="top", wrap_text=True)
                    if isinstance(cell.value, (int, float)):
                        cell.number_format = "#,##0.##"
                row += 1
            row += 1
        else:
            text = value[1] if kind == "heading" else value
            cell = sheet.cell(row, 1, text)
            cell.font = Font(name="맑은 고딕", size=13 if kind == "heading" else 11, bold=kind == "heading")
            cell.alignment = Alignment(wrap_text=True)
            row += 1
    for col in range(1, min(30, sheet.max_column) + 1):
        sheet.column_dimensions[get_column_letter(col)].width = 24
    sheet.freeze_panes = "A4"
    sheet.sheet_view.showGridLines = False
    sheet.print_options.horizontalCentered = True
    sheet.sheet_properties.pageSetUpPr.fitToPage = True
    sheet.page_setup.orientation = "landscape"
    sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0
    stream = io.BytesIO()
    book.save(stream)
    return stream.getvalue()


def make_pptx(title, items):
    from pptx import Presentation
    from pptx.util import Inches, Pt
    from pptx.dml.color import RGBColor
    deck = Presentation()
    deck.slide_width, deck.slide_height = Inches(13.333), Inches(7.5)
    groups = []
    current = []
    slide_title = title
    for kind, value in items:
        if kind == "heading":
            if current:
                groups.append((slide_title, current))
            slide_title, current = value[1], []
        else:
            current.append((kind, value))
    if current or not groups:
        groups.append((slide_title, current))
    slides = []
    for heading, group in groups:
        # Keep long generated decks readable by continuing onto extra slides.
        chunk = []
        count = 0
        for kind, value in group:
            if kind == "table":
                if chunk:
                    slides.append((heading, chunk)); chunk = []; count = 0
                for offset in range(1, len(value), 8):
                    slides.append((heading, [("table", [value[0]] + value[offset:offset + 8])]))
                if len(value) == 1:
                    slides.append((heading, [(kind, value)]))
            else:
                for start in range(0, len(value), 120):
                    units = (len(value[start:start + 120]) + 34) // 35 + 1
                    if count + units > 12 and chunk:
                        slides.append((heading, chunk)); chunk = []; count = 0
                    chunk.append((kind, value[start:start + 120])); count += units
        if chunk or not group:
            slides.append((heading, chunk))
    if len(slides) > 60:
        raise ValueError("프레젠테이션은 60장 이내로 작성해 주세요.")
    for index, (heading, group) in enumerate(slides):
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        slide.background.fill.solid(); slide.background.fill.fore_color.rgb = RGBColor.from_string("F7F7F1")
        box = slide.shapes.add_textbox(Inches(.7), Inches(.5), Inches(11.9), Inches(1.0))
        p = box.text_frame.paragraphs[0]; p.text = heading
        p.font.name = "맑은 고딕"; p.font.size = Pt(30 if len(heading) < 35 else 24 if len(heading) < 65 else 20); p.font.bold = True; p.font.color.rgb = RGBColor.from_string("284638")
        if group and group[0][0] == "table":
            rows = group[0][1]
            if len(rows[0]) > 8:
                raise ValueError("슬라이드 표는 8열 이내로 작성해 주세요.")
            table = slide.shapes.add_table(len(rows), len(rows[0]), Inches(.7), Inches(1.8), Inches(11.9), Inches(4.7)).table
            for r, values in enumerate(rows):
                for c, text in enumerate(values):
                    cell = table.cell(r, c); cell.text = text
                    for paragraph in cell.text_frame.paragraphs:
                        paragraph.font.name = "맑은 고딕"; paragraph.font.size = Pt(14)
        else:
            body = slide.shapes.add_textbox(Inches(.8), Inches(1.85), Inches(11.6), Inches(4.8)).text_frame
            body.word_wrap = True
            for j, (kind, text) in enumerate(group):
                p = body.paragraphs[0] if j == 0 else body.add_paragraph()
                p.text = ("• " if kind == "bullet" else "") + text
                p.font.name = "맑은 고딕"; p.font.size = Pt(22); p.space_after = Pt(18)
        foot = slide.shapes.add_textbox(Inches(.8), Inches(7), Inches(11.6), Inches(.3)).text_frame
        foot.text = f"{title}  ·  {index + 1} / {len(slides)}"
        foot.paragraphs[0].font.size = Pt(10)
        foot.paragraphs[0].font.name = "맑은 고딕"
    stream = io.BytesIO(); deck.save(stream)
    return stream.getvalue()


def make_hangul(title, items, extension):
    from hwpx import HwpxDocument
    doc = HwpxDocument.new()
    doc.add_heading(title, level=1)
    for kind, value in items:
        if kind == "heading":
            doc.add_heading(value[1], level=min(value[0] + 1, 3))
        elif kind == "table":
            table = doc.add_table(rows=len(value), cols=len(value[0]))
            for r, values in enumerate(value):
                for c, text in enumerate(values):
                    table.set_cell_text(r, c, text)
        else:
            doc.add_paragraph(("• " if kind == "bullet" else "") + value)
    if extension == "hwp":
        # Use the library's HWP writer rather than renaming an HWPX archive.
        data = doc.to_bytes(format="hwp")
        if not data.startswith(bytes.fromhex("d0cf11e0a1b11ae1")):
            raise ValueError("HWP 형식 검증에 실패했습니다.")
        return data
    data = doc.to_bytes()
    return data


def inspect(extension, data):
    if extension != "hwp":
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            if len(package.infolist()) > 3000 or sum(item.file_size for item in package.infolist()) > 80 * 1024 * 1024:
                raise ValueError("문서 압축 해제 크기가 너무 큽니다.")
            if package.testzip() is not None:
                raise ValueError("손상된 문서입니다.")
    if extension == "docx":
        from docx import Document
        doc = Document(io.BytesIO(data))
        lines = [p.text for p in doc.paragraphs]
        lines.extend(" | ".join(cell.text for cell in row.cells) for table in doc.tables for row in table.rows)
    elif extension == "xlsx":
        from openpyxl import load_workbook
        doc = load_workbook(io.BytesIO(data), read_only=True, data_only=False, keep_links=False)
        lines = []
        for sheet in doc:
            lines.append("# " + sheet.title)
            for row in sheet.iter_rows(max_row=min(sheet.max_row or 0, 500), max_col=min(sheet.max_column or 0, 30), values_only=True):
                lines.append(" | ".join(str(v) if v is not None else "" for v in row))
        doc.close()
    elif extension == "pptx":
        from pptx import Presentation
        doc = Presentation(io.BytesIO(data))
        lines = []
        for i, slide in enumerate(doc.slides):
            lines.append(f"# 슬라이드 {i + 1}")
            for shape in slide.shapes:
                if shape.has_text_frame:
                    lines.append(shape.text)
                elif shape.has_table:
                    lines.extend(" | ".join(cell.text for cell in row.cells) for row in shape.table.rows)
    else:
        from hwpx import TextExtractor, HwpxDocument
        if extension == "hwp":
            with HwpxDocument.open(io.BytesIO(data)) as converted:
                data = converted.to_bytes()
        lines = [TextExtractor(io.BytesIO(data)).extract_text()]
    text = "\n".join(lines)
    return {"text": text[:16000], "truncated": len(text) > 16000}


def main():
    request = json.load(sys.stdin)
    extension = request.get("format", "")
    if extension not in {"docx", "xlsx", "pptx", "hwpx", "hwp"}:
        raise ValueError("지원하지 않는 문서 형식입니다.")
    if request.get("operation") == "read":
        data = base64.b64decode(request["data"], validate=True)
        if len(data) > 20 * 1024 * 1024:
            raise ValueError("문서는 20MB 이하여야 합니다.")
        return inspect(extension, data)
    title, content = request.get("title", ""), request.get("content", "")
    if not isinstance(title, str) or not title.strip() or len(title) > 120 or not isinstance(content, str) or not content.strip() or len(content) > 60000:
        raise ValueError("제목 120자·본문 60,000자 이내로 입력해 주세요.")
    items = blocks(content)
    if extension == "docx":
        data = make_docx(title, items)
    elif extension == "xlsx":
        data = make_xlsx(title, items)
    elif extension == "pptx":
        data = make_pptx(title, items)
    else:
        data = make_hangul(title, items, extension)
    verified = inspect(extension, data)
    return {"data": base64.b64encode(data).decode("ascii"), "bytes": len(data), "preview": verified["text"][:1500]}


if __name__ == "__main__":
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)[:500]}, ensure_ascii=False))
        sys.exit(1)
