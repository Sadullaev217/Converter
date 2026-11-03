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

See **[`examples/`](examples/)** for a worked conversion: an input PDF, the
rebuilt `.docx`, and page-by-page renders of the result.

## How the rebuild pipeline works

```
input.pdf
   │
   ├─ pdfimages -png            → extract every embedded image + its source page
   ├─ pdftotext -layout          → per-page, layout-preserved text
   ├─ pdftohtml -xml             → per-line font size / bold / family
   ├─ pdftotext -bbox-layout     → per-line bounding boxes (points)
   │
   ▼
parser (scripts/pdf-to-docx/parseDocument.js)
   → strips repeated headers/footers and page numbers
   → flat document model: headings, paragraphs, bullet/numbered lists,
     tables, code blocks, callout boxes, images — in reading order, with
     images placed between the paragraphs they sat between in the PDF
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
verification (soffice --headless --convert-to pdf → pdftoppm -png)   [skippable]
   → renders the generated .docx back to page images so you can eyeball
     that headings/tables/images actually landed correctly
```

Structure detection prefers **font data** when it's available: `pdftohtml
-xml` gives each line's font size, weight and family, so headings are
detected by being larger or bolder than the document's body text (measured
across the whole document), and code by using a monospace font — far more
reliable than guessing from capitalisation. When font data can't be read it
falls back to text-shape heuristics: ALL-CAPS or short title-cased lines
become headings, `- `/`* `/`1. ` prefixes become lists, consistent 2+-space
column gaps become tables, `WARNING:` / `NOTE:` / `IMPORTANT:` / `TIP:` /
`SCREENSHOT REQUIRED:` become colored callout boxes, and indented or fenced
blocks become monospace code.

Running headers, footers and `Page N of M` lines that repeat across pages
are detected and dropped so they don't leak into the body, and a logo
repeated in the header/footer of every page is dropped the same way. A PDF
with no extractable text layer (a scan) is detected and the tool prints a
warning — it still embeds the page images, but there's no built-in OCR.

It's tuned for the common case — a text-plus-screenshots technical document
— not exotic multi-column or rotated layouts.

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
npm install   # installs docx from package.json
node scripts/pdf-to-docx.js <input.pdf> <output.docx> [--tmpdir <dir>] [--no-verify]
```

- `--tmpdir <dir>` — where intermediate extraction files go (defaults to the
  OS temp dir). A fresh subdirectory is created under it per run.
- `--no-verify` — skip the LibreOffice/pdftoppm render-back step. The `.docx`
  is still written; it's just not rendered to check images. Faster, and it
  means **LibreOffice isn't required** — handy for batch/server use (the web
  app passes this).
- With verification on, the tool prints the paths of the rendered check
  images so you can eyeball the output. Raw extraction intermediates are
  deleted on success; the check images are left on disk for review. On
  failure, all temp files are left in place and the path is printed.
- Exits non-zero with a clear message if a required tool isn't on PATH
  (`pdfimages`/`pdftotext` always; `pdftoppm`/`soffice` only without
  `--no-verify`).

### Dependencies

- **Node.js** + the [`docx`](https://www.npmjs.com/package/docx) package
  (docx-js) for generating the `.docx`.
- **Poppler** (`pdfimages`, `pdftotext`, `pdftohtml`) for image/text/font
  extraction. On Windows, install the full Poppler build (the one bundled
  with Git for Windows is Xpdf and lacks `-bbox-layout`); the tool prefers a
  complete Poppler install on PATH automatically.
- **LibreOffice** (`soffice`) and Poppler's `pdftoppm` for the verification
  render-back step only — not needed with `--no-verify`. On Windows the
  tool also looks for `soffice.exe` in its default install location when
  it's not on PATH.

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

### Tests

```bash
npm test
```

Runs the [`node:test`](https://nodejs.org/api/test.html) suite in `tests/`:
unit tests for the parser's pure functions (callout/table/heading detection,
header-footer removal, numbering independence, the XML parsers) plus one
golden end-to-end test that runs the real CLI on `tests/fixtures/sample.pdf`
and asserts the produced `.docx` is a valid OOXML package with the expected
headings, lists, table, code, callout and embedded image. The unit tests
need nothing extra; the e2e test needs Poppler on PATH and skips itself if
it's missing. CI runs the whole suite on every push (`.github/workflows/ci.yml`).

To regenerate the fixture PDF (needs `reportlab` + `pillow`):

```bash
python tests/fixtures/make_sample_pdf.py
```

## The rest of the converter (web app)

`backend/app.py` (Flask) + `frontend/index.html` (static, no build step) is
a small "convert any format to any other format" shell around the routing
table below. Images go through Pillow, PDF text/image extraction through
PyMuPDF, `docx → pdf` through **LibreOffice headless** (`soffice
--convert-to`, which preserves layout/fonts/images/tables — it falls back to
a plain text reflow only if LibreOffice isn't installed), and `pdf → docx`
by shelling out to the structural-rebuild tool above.

| From | To |
|---|---|
| png, jpg, jpeg, webp, bmp, gif, tiff | any of the others |
| pdf | txt (extracted text) |
| pdf | png (one image per page, zipped) |
| **pdf** | **docx (structural rebuild — see above)** |
| docx | txt |
| docx | pdf (high-fidelity via LibreOffice — layout, fonts, images, tables preserved) |
| txt | pdf |

All conversions run locally, no external API calls, no API keys needed
(there's an optional Gemini-backed AI fallback for unsupported pairs, off
by default).

### How to run it

```bash
cd backend
pip install -r requirements.txt
python3 app.py
```

This starts the API on `http://127.0.0.1:5050`. Then open
`frontend/index.html` directly in your browser — it's a static page that
calls the API, no server needed for it.

The server binds to localhost only by default (the optional AI fallback
executes generated code, so it shouldn't be network-reachable without
thought) and caps uploads at 25 MB. Both are configurable by environment
variable:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` to expose it on the network (do this deliberately). |
| `PORT` | `5050` | API port. |
| `MAX_UPLOAD_MB` | `25` | Upload size limit; oversized uploads get a clean 413. |

**Important:** since the `pdf → docx` route shells out to
`scripts/pdf-to-docx.js` with `--no-verify`, start `python3 app.py` from a
terminal where `node`, `pdfimages`, `pdftotext`, and `pdftohtml` are all
resolvable on PATH, or that one route will fail while everything else still
works. (LibreOffice isn't needed for the web route — only for the CLI's
verification step.)

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

### Deploying it online

The whole app runs as **one Docker container** — Flask serves both the API
and the static frontend (same origin), and shells out to the Node tool. The
image bundles Python + Node + Poppler + **LibreOffice Writer** (for
high-fidelity `docx → pdf`; Writer only, not full LibreOffice, to stay
lean). LibreOffice is memory-heavy, so the blueprint sets `WEB_CONCURRENCY=1`
— on Render's free 512 MB instance that avoids OOM; bump it on a bigger plan.

**Render (one-click-ish):**

1. Push this repo to GitHub (already done if you're reading this there).
2. On [dashboard.render.com](https://dashboard.render.com): **New + → Blueprint**,
   pick this repo. It reads [`render.yaml`](render.yaml) and provisions a free
   Docker web service. (Or **New + → Web Service → Docker** and point it at the repo.)
3. Wait for the build, then open the `…onrender.com` URL — the converter UI
   loads and works.

**Run the container anywhere else:**

```bash
docker build -t converter .
docker run -p 5050:5050 converter
# open http://localhost:5050
```

Public-deployment behavior (all overridable by env var, see `render.yaml`):

- **Localhost-safe AI fallback stays off**: `GEMINI_API_KEY` is left unset, so
  the code-executing fallback is disabled.
- **Per-IP rate limiting** via `flask-limiter` (`RATE_LIMITS`, default
  `60 per hour;10 per minute`; empty string disables it).
- **Upload cap** (`MAX_UPLOAD_MB`, default 25) and **auto-cleanup** of converted
  files older than `OUTPUT_TTL_SECONDS` (default 3600) so the disk doesn't fill.

Notes / further hardening:

- Render's **free instance sleeps after ~15 min idle**; the first request after
  that takes ~30s to wake. Upgrade the plan to keep it warm.
- Converted files live on the container's ephemeral disk. For durability or
  horizontal scaling, swap to S3-style object storage with expiry.
- Conversion is **synchronous** inside the request. For large files or heavy
  load, move it to a queue (Celery + Redis, or BullMQ).
- **Full-fidelity Office conversion** (pptx, xlsx, pixel-perfect docx↔pdf)
  would add LibreOffice (`soffice --headless --convert-to pdf`) to the image.
- **Video/audio** could follow the same routing pattern with an `ffmpeg` engine.

## Files

- `scripts/pdf-to-docx.js` — CLI entry point for the PDF → DOCX rebuild tool
- `scripts/pdf-to-docx/` — its modules: `checkDeps` (tool resolution),
  `extractImages`, `extractText`, `layoutInfo` (font/geometry), `parseDocument`
  (the document model), `buildDocx` (docx-js assembly), `verify`, `cli`
- `tests/` — `node:test` unit + golden e2e tests, with `fixtures/`
- `backend/app.py` — Flask API + all conversion engines
- `frontend/index.html` — drag-and-drop UI, talks to the API
