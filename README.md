# PDF → DOCX Structural Rebuild (in a small Universal File Converter)

The centerpiece of this repo is [`scripts/pdf-to-docx.js`](scripts/pdf-to-docx.js):
a PDF → DOCX converter that **rebuilds** the document instead of doing a lossy
pass-through. Most "pdf to word" tools either just dump extracted text into a
`.docx`, or wrap a monolithic converter binary as a black box. This one
extracts the PDF's actual content, parses it into a document model, and
reconstructs it natively as Word XML — so headings are real Word headings,
lists are real Word lists, and tables have explicit column widths instead of
whatever Word decides to autofit.

It's wired into a small Flask + vanilla-JS web app (upload a file, pick a
target format, download the result) so it's usable from a browser, not just
the CLI. That app also happens to do a handful of other prototype-grade
conversions (images, basic docx↔pdf/txt) — more on those [below](#the-rest-of-the-converter-web-app).

## How the rebuild pipeline works

```
input.pdf
   │
   ├─ pdfimages -png          → extract every embedded image + its source page
   ├─ pdftotext -layout        → per-page, layout-preserved text
   │
   ▼
heuristic parser (scripts/pdf-to-docx/parseDocument.js)
   → flat document model: headings, paragraphs, bullet/numbered lists,
     tables, code blocks, callout boxes, images — interleaved in reading order
   │
   ▼
docx-js assembly (scripts/pdf-to-docx/buildDocx.js)
   → real HeadingLevel paragraphs, Table/TableRow/TableCell with explicit
     WidthType.DXA column widths, ShadingType.CLEAR-shaded code blocks,
     bordered callout tables, scaled ImageRuns, independent numbering
     instances per list
   │
   ▼
output.docx
   │
   ▼
verification (soffice --headless --convert-to pdf → pdftoppm -png)
   → renders the generated .docx back to page images so you can eyeball
     that headings/tables/images actually landed correctly
```

Since `pdftotext -layout` gives monospace-aligned text with no font-size or
boldness metadata, structure detection is heuristic: ALL-CAPS or short
title-cased lines become headings, `- `/`* `/`1. ` prefixes become lists,
lines with consistent 2+-space column gaps become tables, `WARNING:` /
`NOTE:` / `IMPORTANT:` / `TIP:` become colored callout boxes, and indented or
fenced blocks become monospace code. It's tuned for the common case — a
text-plus-screenshots technical document — not exotic multi-column or
rotated layouts.

**A real bug this surfaced during testing:** giving every numbered list in
the document the same docx numbering reference makes Word/LibreOffice count
them as *one continuous list* — an unrelated list later in the document
picks up numbering where the previous one left off (4, 5, 6...) instead of
restarting at 1. Fixed by generating one numbering instance per detected
list block (see `listId` in `parseDocument.js` / `buildDocx.js`) so each
list restarts independently, matching what Word actually does with
visually distinct lists.

## Usage

```bash
npm install   # installs docx (+ pdf-parse) from package.json
node scripts/pdf-to-docx.js <input.pdf> <output.docx> [--tmpdir <dir>]
```

- `--tmpdir <dir>` — where intermediate extraction files go (defaults to the
  OS temp dir). A fresh subdirectory is created under it per run.
- Prints the paths of the rendered verification images so you can visually
  confirm the output before trusting it. Raw extraction intermediates are
  deleted on success; the verification images are intentionally left on disk
  for review. On failure, all temp files are left in place and the path is
  printed for debugging.
- Exits non-zero with a clear message if `pdfimages`, `pdftotext`,
  `pdftoppm`, or `soffice` aren't on PATH.

### Dependencies

- **Node.js** + the [`docx`](https://www.npmjs.com/package/docx) package
  (docx-js) for generating the `.docx`.
- **Poppler** (`pdfimages`, `pdftotext`, `pdftoppm`) for image/text
  extraction and rendering verification pages.
- **LibreOffice** (`soffice`) for the verification render-back step only.

```bash
# Windows (winget) — no admin rights needed
winget install oschwartz10612.Poppler
winget install TheDocumentFoundation.LibreOffice
# LibreOffice's Windows installer does not add soffice.exe to PATH — add
# "C:\Program Files\LibreOffice\program" to your user PATH afterward.

# Windows (choco) — requires an elevated shell
choco install poppler libreoffice-fresh -y

# Debian/Ubuntu
sudo apt-get install poppler-utils libreoffice

# macOS (Homebrew)
brew install poppler
brew install --cask libreoffice
```

### What it deliberately doesn't do

No all-in-one "pdf to docx" converter binary/library under the hood — the
point is a controlled, inspectable rebuild you can read and tune. It's not
trying to perfectly replicate exotic PDF layouts (multi-column, rotated
text); it optimizes for the common technical-document case.

## The rest of the converter (web app)

`backend/app.py` (Flask) + `frontend/index.html` (static, no build step) is
a small "convert any format to any other format" shell around the routing
table below. It's honestly a thinner prototype than the PDF→DOCX piece —
images go through Pillow, PDF text/image extraction through PyMuPDF, and
`docx → pdf` is a naive text reflow, not pixel-perfect layout. `pdf → docx`
is the one route with real fidelity, because it calls out to the Node tool
above.

| From | To |
|---|---|
| png, jpg, jpeg, webp, bmp, gif, tiff | any of the others |
| pdf | txt (extracted text) |
| pdf | png (one image per page, zipped) |
| **pdf** | **docx (structural rebuild — see above)** |
| docx | txt |
| docx | pdf (basic text reflow — not pixel-perfect layout) |
| txt | pdf |

All conversions run locally, no external API calls, no API keys needed
(there's an optional Gemini-backed AI fallback for unsupported pairs, off
by default).

### How to run it

```bash
cd backend
pip install flask flask-cors pillow python-docx PyMuPDF reportlab
python3 app.py
```

This starts the API on `http://localhost:5050`. Then open
`frontend/index.html` directly in your browser — it's a static page that
calls the API, no server needed for it.

**Important:** since the `pdf → docx` route shells out to
`scripts/pdf-to-docx.js`, start `python3 app.py` from a terminal where
`node`, `pdfimages`, `pdftotext`, `pdftoppm`, and `soffice` are all
resolvable on PATH, or that one route will fail while everything else still
works.

### How it's architected

```
frontend/index.html  →  POST /api/convert  →  routes by (source_ext, target_ext)
                                             →  dedicated "engine" function
                                             →  saved to /tmp/converter_outputs
                                             →  GET /api/download/<file> returns it
```

Conversions are routed by category, not handled by one universal function:
images through Pillow, PDFs through PyMuPDF, DOCX through python-docx +
reportlab, and `pdf → docx` by shelling out to the Node tool. Each format
family is its own pipeline that can be swapped, scaled, or outsourced
independently.

### Taking this to production

1. **Full-fidelity Office conversion** (pptx, xlsx, pixel-perfect docx↔pdf):
   shell out to `soffice --headless --convert-to pdf` the way `pdf → docx`
   already does — this is what most converter SaaS products use under the
   hood.
2. **Async jobs**: conversion currently happens synchronously inside the
   request. For large files or slow conversions (the PDF→DOCX verify step
   launches LibreOffice), move this to a queue (Celery + Redis, or BullMQ)
   so uploads don't time out.
3. **Storage**: swap `/tmp` for S3 or equivalent object storage with
   auto-expiring uploaded/converted files.
4. **Video/audio**: add an `ffmpeg`-based engine following the same routing
   pattern as the image engine.
5. **Auth & rate limiting** if this becomes a public product.
6. **Deploy**: containerize the Flask app (Docker) with Node + Poppler +
   LibreOffice baked into the image, behind gunicorn, with the frontend on
   a CDN or static host.

## Files

- `scripts/pdf-to-docx.js` — CLI entry point for the PDF → DOCX rebuild tool
- `scripts/pdf-to-docx/` — its extraction/parsing/assembly/verification modules
- `backend/app.py` — Flask API + all conversion engines
- `frontend/index.html` — drag-and-drop UI, talks to the API
