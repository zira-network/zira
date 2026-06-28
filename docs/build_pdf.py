# Build polished PDFs (whitepaper + manifesto) from the markdown, with a cover,
# auto-paginated table of contents, branded headings, and styled tables.
# Self-contained: parses the markdown directly, no markdown lib needed.
import re
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.enums import TA_JUSTIFY, TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, PageBreak,
    Table, TableStyle, ListFlowable, ListItem, NextPageTemplate, CondPageBreak,
)
from reportlab.platypus.tableofcontents import TableOfContents

# ---- brand ----
TEAL = colors.HexColor("#0D9488")
VIOLET = colors.HexColor("#5B5BD6")
INK = colors.HexColor("#0E1726")
MUTED = colors.HexColor("#5B6472")
FAINT = colors.HexColor("#8A93A0")
HAIR = colors.HexColor("#DCE1E8")
ROWBG = colors.HexColor("#F4F7F9")

PAGE = A4
LM = RM = 22 * mm
TM = 20 * mm
BM = 20 * mm
CONTENT_W = PAGE[0] - LM - RM

ss = getSampleStyleSheet()

def style(name, **kw):
    return ParagraphStyle(name, **kw)

body = style("body", parent=ss["BodyText"], fontName="Helvetica", fontSize=9.6,
             leading=14.6, alignment=TA_JUSTIFY, textColor=INK, spaceAfter=7)
lede = style("lede", parent=body, fontSize=11, leading=16, textColor=MUTED, spaceAfter=10)
h2 = style("ChapterH", fontName="Helvetica-Bold", fontSize=17, leading=21,
           textColor=INK, spaceBefore=4, spaceAfter=4, keepWithNext=1)
eyebrow = style("eyebrow", fontName="Helvetica-Bold", fontSize=8, leading=11,
                textColor=TEAL, spaceAfter=2, tracking=1)
h3 = style("h3", fontName="Helvetica-Bold", fontSize=11, leading=15, textColor=INK,
           spaceBefore=8, spaceAfter=3, keepWithNext=1)
bullet = style("bullet", parent=body, spaceAfter=3, leading=14)
note = style("note", parent=body, fontSize=9, leading=13.5, textColor=MUTED)
tcell = style("tcell", fontName="Helvetica", fontSize=8.6, leading=11.5, textColor=INK)
tcellnum = style("tcellnum", parent=tcell, alignment=TA_RIGHT)
thead = style("thead", fontName="Helvetica-Bold", fontSize=8.6, leading=11.5, textColor=colors.white)
toc_h = style("toc_h", fontName="Helvetica-Bold", fontSize=18, leading=22, textColor=INK, spaceAfter=12)

# cover styles
cv_title = style("cv_title", fontName="Helvetica-Bold", fontSize=58, leading=60, textColor=INK, alignment=TA_LEFT)
cv_tag = style("cv_tag", fontName="Helvetica", fontSize=14, leading=20, textColor=TEAL, alignment=TA_LEFT, spaceBefore=10)
cv_sub = style("cv_sub", fontName="Helvetica-Oblique", fontSize=11, leading=16, textColor=MUTED, alignment=TA_LEFT, spaceBefore=6)
cv_meta = style("cv_meta", fontName="Helvetica-Bold", fontSize=10, leading=14, textColor=INK, alignment=TA_LEFT)
cv_foot = style("cv_foot", fontName="Helvetica", fontSize=8.5, leading=12, textColor=FAINT, alignment=TA_LEFT)

# ---- inline markdown ----
def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def inline(s):
    s = esc(s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"`(.+?)`", r'<font name="Courier" size="8.6">\1</font>', s)
    s = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<i>\1</i>", s)
    return s

NUM = re.compile(r"^[\d,]+(\.\d+)?%?$")

def is_num(x):
    return bool(NUM.match(x.strip()))

def make_table(rows):
    header = [c.strip() for c in rows[0].strip().strip("|").split("|")]
    data_rows = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows[2:]]
    ncols = len(header)
    # which columns are numeric (by body content)
    numeric_col = [all(is_num(r[i]) for r in data_rows if i < len(r)) for i in range(ncols)]
    tdata = [[Paragraph(inline(h), thead) for h in header]]
    for r in data_rows:
        cells = []
        for i in range(ncols):
            txt = r[i] if i < len(r) else ""
            cells.append(Paragraph(inline(txt), tcellnum if numeric_col[i] else tcell))
        tdata.append(cells)
    # column widths: first column a bit wider
    w0 = CONTENT_W * (0.26 if ncols <= 4 else 0.20)
    rest = (CONTENT_W - w0) / (ncols - 1)
    widths = [w0] + [rest] * (ncols - 1)
    t = Table(tdata, colWidths=widths, repeatRows=1)
    ts = [
        ("BACKGROUND", (0, 0), (-1, 0), TEAL),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, HAIR),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ROWBG]),
        ("BOX", (0, 0), (-1, -1), 0.5, HAIR),
    ]
    t.setStyle(TableStyle(ts))
    return t

def render_chapter(num, title, lines):
    flow = [Paragraph(f"CHAPTER {num:02d}", eyebrow), Paragraph(inline(f"{num}. {title}"), h2),
            Spacer(1, 4)]
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if not line.strip():
            i += 1; continue
        m3 = re.match(r"^### (.+)$", line)
        if m3:
            flow.append(Paragraph(inline(m3.group(1).strip()), h3)); i += 1; continue
        if line.strip().startswith("|"):
            tbl = []
            while i < n and lines[i].strip().startswith("|"):
                tbl.append(lines[i]); i += 1
            flow.append(Spacer(1, 3)); flow.append(make_table(tbl)); flow.append(Spacer(1, 7))
            continue
        if re.match(r"^[-*] ", line.strip()):
            items = []
            while i < n and re.match(r"^[-*] ", lines[i].strip()):
                items.append(lines[i].strip()[2:]); i += 1
            li = [ListItem(Paragraph(inline(it), bullet), leftIndent=10, value="•") for it in items]
            flow.append(ListFlowable(li, bulletType="bullet", start="•", leftIndent=12,
                                     bulletColor=TEAL, bulletFontSize=8))
            flow.append(Spacer(1, 4))
            continue
        if line.strip().startswith(">"):
            q = re.sub(r"^>\s?", "", line.strip())
            flow.append(Spacer(1, 2)); flow.append(Paragraph(inline(q), note)); flow.append(Spacer(1, 4))
            i += 1; continue
        flow.append(Paragraph(inline(line.strip()), body)); i += 1
    return flow

# ---- parse markdown into front matter + chapters ----
def parse(md):
    lines = md.split("\n")
    abstract = []
    status = []
    chapters = []
    cur = None
    mode = None
    for line in lines:
        mc = re.match(r"^## (\d+)\. (.+)$", line)
        if mc:
            cur = {"num": int(mc.group(1)), "title": mc.group(2).strip(), "body": []}
            chapters.append(cur); mode = "chapter"; continue
        if re.match(r"^## Abstract", line):
            mode = "abstract"; continue
        if re.match(r"^## Table of contents", line):
            mode = "skip"; continue
        if line.strip().startswith("> **Document status"):
            mode = "status"
            status.append(re.sub(r"^>\s?", "", line.strip())); continue
        if mode == "chapter" and cur is not None:
            cur["body"].append(line)
        elif mode == "abstract":
            if line.strip() and not line.startswith("#"):
                abstract.append(line.strip())
        elif mode == "status":
            if line.strip().startswith(">"):
                status.append(re.sub(r"^>\s?", "", line.strip()))
            elif line.strip() == "":
                pass
            else:
                mode = None
    return abstract, status, chapters

# ---- document with cover + toc page templates and footer ----
class Doc(BaseDocTemplate):
    def __init__(self, path, **kw):
        super().__init__(path, pagesize=PAGE, leftMargin=LM, rightMargin=RM,
                         topMargin=TM, bottomMargin=BM, **kw)
        frame = Frame(LM, BM, CONTENT_W, PAGE[1] - TM - BM, id="main")
        self.addPageTemplates([
            PageTemplate(id="cover", frames=[frame], onPage=self._cover_bg),
            PageTemplate(id="body", frames=[frame], onPage=self._footer),
        ])

    def _cover_bg(self, canvas, doc):
        canvas.saveState()
        canvas.setFillColor(TEAL)
        canvas.rect(0, PAGE[1] - 10 * mm, PAGE[0], 10 * mm, fill=1, stroke=0)
        canvas.setFillColor(VIOLET)
        canvas.rect(0, PAGE[1] - 13 * mm, PAGE[0], 3 * mm, fill=1, stroke=0)
        canvas.restoreState()

    def _footer(self, canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(HAIR)
        canvas.setLineWidth(0.5)
        canvas.line(LM, BM - 5 * mm, PAGE[0] - RM, BM - 5 * mm)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(FAINT)
        canvas.drawString(LM, BM - 9 * mm, "ZIRA · Whitepaper v2.0")
        canvas.drawRightString(PAGE[0] - RM, BM - 9 * mm, "Page %d" % doc.page)
        canvas.restoreState()

    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph) and flowable.style.name == "ChapterH":
            txt = flowable.getPlainText()
            self.notify("TOCEntry", (0, txt, self.page))

def build_whitepaper(md_path, out_path):
    with open(md_path, encoding="utf-8") as f:
        md = f.read()
    abstract, status, chapters = parse(md)
    story = []

    # cover
    story.append(Spacer(1, 52 * mm))
    story.append(Paragraph("ZIRA", cv_title))
    story.append(Paragraph("One network of models and people,<br/>owned by no one and verifiable by everyone.", cv_tag))
    story.append(Paragraph("A neural economy where intelligence, trust, budget, and verification meet in the open.", cv_sub))
    story.append(Spacer(1, 60 * mm))
    story.append(Paragraph("Whitepaper · Version 2.0", cv_meta))
    story.append(Paragraph("Protocol reference for the field, ZIR, Proof of Resonance, and the 512-seat lattice.", cv_foot))
    story.append(Spacer(1, 3))
    story.append(Paragraph("Informational only. Not investment or legal advice. ZIR is earned, not sold.", cv_foot))
    story.append(NextPageTemplate("body"))
    story.append(PageBreak())

    # abstract + status
    story.append(Paragraph("Abstract", toc_h))
    for p in abstract:
        story.append(Paragraph(inline(p), body))
    if status:
        story.append(Spacer(1, 6))
        story.append(Paragraph("Document status", h3))
        story.append(Paragraph(inline(" ".join(status).replace("**", "")), note))
    story.append(PageBreak())

    # table of contents
    story.append(Paragraph("Contents", toc_h))
    toc = TableOfContents()
    toc.levelStyles = [style("toc0", fontName="Helvetica", fontSize=10.5, leading=20,
                             textColor=INK, leftIndent=0, firstLineIndent=0)]
    story.append(toc)
    story.append(PageBreak())

    # chapters
    for ci, ch in enumerate(chapters):
        story += render_chapter(ch["num"], ch["title"], ch["body"])
        if ci != len(chapters) - 1:
            story.append(Spacer(1, 10))

    doc = Doc(out_path)
    doc.multiBuild(story)
    print("wrote", out_path)

def build_manifesto(md_path, out_path):
    with open(md_path, encoding="utf-8") as f:
        md = f.read()
    lines = md.split("\n")
    story = []
    story.append(Spacer(1, 30 * mm))
    story.append(Paragraph("The ZIRA Manifesto", style("m_title", fontName="Helvetica-Bold",
                 fontSize=30, leading=34, textColor=INK)))
    story.append(Paragraph("One network of models and people, owned by no one and verifiable by everyone.",
                 style("m_tag", fontName="Helvetica", fontSize=12, leading=17, textColor=TEAL, spaceBefore=8, spaceAfter=14)))
    mbody = style("m_body", parent=body, fontSize=10.5, leading=16, spaceAfter=9)
    for line in lines:
        s = line.strip()
        if not s or s.startswith("#") or s == "---":
            continue
        if s.startswith("###"):
            continue
        story.append(Paragraph(inline(s), mbody))
    doc = Doc(out_path)
    doc.build(story)
    print("wrote", out_path)

if __name__ == "__main__":
    build_whitepaper("ZIRA_WHITEPAPER.md", "ZIRA_Whitepaper_v2.pdf")
    build_manifesto("ZIRA_MANIFESTO.md", "ZIRA_Manifesto.pdf")
