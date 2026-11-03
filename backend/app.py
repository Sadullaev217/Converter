"""
Universal Document Converter - Backend Prototype
==================================================
Demonstrates the core architecture for a "convert any format to any format" app:
  1. File comes in -> we detect its category (image / document)
  2. We route it to the right conversion engine for that category
  3. Result is saved and a download link is returned

This prototype implements REAL conversions using free, open libraries:
  - Images (png/jpg/jpeg/webp/bmp/gif/tiff) -> any of those formats        [Pillow]
  - PDF -> plain text                                                      [PyMuPDF]
  - PDF -> images (one PNG per page, zipped)                               [PyMuPDF]
  - DOCX -> plain text                                                     [python-docx]
  - DOCX -> PDF (simple text reflow, not pixel-perfect layout)             [python-docx + reportlab]
  - TXT -> PDF                                                             [reportlab]
  - PDF -> DOCX (structural rebuild: headings/lists/tables/images)         [scripts/pdf-to-docx.js, docx-js]

For production-grade DOCX/PPTX/XLSX <-> PDF conversion with full fidelity
(fonts, layout, images, tables preserved exactly), swap in LibreOffice
headless (`soffice --convert-to`) as described in the README. This prototype
avoids that dependency so it runs anywhere without a heavy install.
"""

import os
import io
import re
import time
import uuid
import shutil
import zipfile
import subprocess
from pathlib import Path

import tempfile
from flask import Flask, request, send_file, jsonify, send_from_directory
from flask_cors import CORS
from PIL import Image
import fitz  # PyMuPDF
import docx
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from reportlab.lib.units import inch
from ai_fallback import ai_convert

app = Flask(__name__, static_folder="../frontend", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("MAX_UPLOAD_MB", 25)) * 1024 * 1024
CORS(app)

# Per-IP rate limiting: this endpoint does real conversion work, so a public
# deployment needs a basic abuse guard. Degrades gracefully if the package
# isn't installed (local dev) or limits are disabled via env.
RATE_LIMITS = os.environ.get("RATE_LIMITS", "60 per hour;10 per minute")
try:
    from flask_limiter import Limiter
    from flask_limiter.util import get_remote_address

    limiter = Limiter(
        get_remote_address,
        app=app,
        default_limits=[l.strip() for l in RATE_LIMITS.split(";") if l.strip()] if RATE_LIMITS else [],
        storage_uri="memory://",
    )
except ImportError:
    limiter = None

UPLOAD_DIR = Path(tempfile.gettempdir()) / "converter_uploads"
OUTPUT_DIR = Path(tempfile.gettempdir()) / "converter_outputs"
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

# On ephemeral hosts (Render etc.) converted files pile up in a temp dir;
# drop anything older than this so the disk doesn't slowly fill.
OUTPUT_TTL_SECONDS = int(os.environ.get("OUTPUT_TTL_SECONDS", 3600))

REPO_ROOT = Path(__file__).resolve().parent.parent

# LibreOffice (soffice) gives high-fidelity office->pdf conversion. Resolved
# once; None means it's not installed and we fall back to a basic engine.
_SOFFICE_FALLBACKS = [
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
]


def find_soffice():
    found = shutil.which("soffice") or shutil.which("soffice.exe")
    if found:
        return found
    return next((p for p in _SOFFICE_FALLBACKS if os.path.exists(p)), None)


SOFFICE = find_soffice()


def soffice_convert(src_path: Path, out_path: Path, target_ext: str) -> None:
    """Convert `src_path` to `target_ext` with headless LibreOffice, preserving
    layout/fonts/images. Each call uses its own LibreOffice profile so
    concurrent requests don't lock each other."""
    if not SOFFICE:
        raise RuntimeError("LibreOffice (soffice) is not installed")
    with tempfile.TemporaryDirectory() as tmp:
        profile = (Path(tmp) / "profile").as_uri()
        result = subprocess.run(
            [SOFFICE, f"-env:UserInstallation={profile}", "--headless",
             "--convert-to", target_ext, "--outdir", tmp, str(src_path)],
            capture_output=True, text=True, timeout=120,
        )
        produced = Path(tmp) / f"{src_path.stem}.{target_ext}"
        if result.returncode != 0 or not produced.exists():
            detail = (result.stderr or result.stdout or "unknown error").strip()
            raise RuntimeError(f"LibreOffice conversion failed: {detail}")
        shutil.move(str(produced), str(out_path))


def cleanup_dir(directory: Path, ttl: int = OUTPUT_TTL_SECONDS) -> None:
    """Best-effort deletion of files in `directory` older than `ttl` seconds."""
    cutoff = time.time() - ttl
    try:
        for entry in directory.iterdir():
            try:
                if entry.is_file() and entry.stat().st_mtime < cutoff:
                    entry.unlink()
            except OSError:
                pass
    except OSError:
        pass
PDF_TO_DOCX_SCRIPT = REPO_ROOT / "scripts" / "pdf-to-docx.js"

IMAGE_FORMATS = {"png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff"}

# Map of (source_ext, target_ext) -> which engine handles it.
# This is the "routing table" — the heart of a multi-format converter.
SUPPORTED_ROUTES = {
    # images -> images (any combination)
    **{(s, t): "image" for s in IMAGE_FORMATS for t in IMAGE_FORMATS if s != t},
    ("pdf", "txt"): "pdf_to_text",
    ("pdf", "png"): "pdf_to_images",
    ("pdf", "docx"): "pdf_to_docx",
    ("docx", "txt"): "docx_to_text",
    ("docx", "pdf"): "docx_to_pdf",
    ("txt", "pdf"): "txt_to_pdf",
}


def ext_of(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


# Extensions end up in filesystem paths, so only short alphanumeric ones are accepted.
SAFE_EXT_RE = re.compile(r"^[a-z0-9]{1,8}$")


@app.errorhandler(413)
def too_large(_e):
    limit_mb = app.config["MAX_CONTENT_LENGTH"] // (1024 * 1024)
    return jsonify({"error": f"File too large (limit is {limit_mb} MB)"}), 413


@app.route("/", methods=["GET"])
def home():
    return app.send_static_file("index.html")


@app.route("/api/formats", methods=["GET"])
def formats():
    """Tell the frontend what conversions are currently possible."""
    routes = sorted([f"{s}->{t}" for (s, t) in SUPPORTED_ROUTES])
    ai_enabled = bool(os.environ.get("GEMINI_API_KEY"))
    return jsonify({"routes": routes, "ai_fallback_enabled": ai_enabled})


@app.route("/api/convert", methods=["POST"])
def convert():
    cleanup_dir(OUTPUT_DIR)
    cleanup_dir(UPLOAD_DIR)

    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    target_format = request.form.get("target_format", "").lower().strip()
    if not target_format:
        return jsonify({"error": "No target_format specified"}), 400

    source_ext = ext_of(file.filename or "")
    if not SAFE_EXT_RE.match(source_ext) or not SAFE_EXT_RE.match(target_format):
        return jsonify({"error": "Invalid file extension or target_format"}), 400
    route_key = (source_ext, target_format)

    job_id = str(uuid.uuid4())[:8]
    src_path = UPLOAD_DIR / f"{job_id}.{source_ext}"
    file.save(src_path)

    if route_key in SUPPORTED_ROUTES:
        engine = SUPPORTED_ROUTES[route_key]
        try:
            if engine == "image":
                out_path = _convert_image(src_path, job_id, target_format)
            elif engine == "pdf_to_text":
                out_path = _pdf_to_text(src_path, job_id)
            elif engine == "pdf_to_images":
                out_path = _pdf_to_images_zip(src_path, job_id)
            elif engine == "pdf_to_docx":
                out_path = _pdf_to_docx(src_path, job_id)
            elif engine == "docx_to_text":
                out_path = _docx_to_text(src_path, job_id)
            elif engine == "docx_to_pdf":
                out_path = _docx_to_pdf(src_path, job_id)
            elif engine == "txt_to_pdf":
                out_path = _txt_to_pdf(src_path, job_id)
            else:
                return jsonify({"error": "Engine not implemented"}), 500
        except Exception as e:
            return jsonify({"error": f"Conversion failed: {e}"}), 500
        finally:
            src_path.unlink(missing_ok=True)

        return jsonify({
            "job_id": job_id,
            "download_url": f"/api/download/{out_path.name}",
            "method": "builtin"
        })

    # No hardcoded engine for this pair -> try the AI fallback
    if not os.environ.get("GEMINI_API_KEY"):
        src_path.unlink(missing_ok=True)
        return jsonify({
            "error": f"Conversion {source_ext} -> {target_format} not supported, and "
                     f"GEMINI_API_KEY is not set so the AI fallback is unavailable.",
        }), 400

    out_path = OUTPUT_DIR / f"{job_id}.{target_format}"
    success, message = ai_convert(src_path, source_ext, target_format, out_path)
    src_path.unlink(missing_ok=True)

    if not success:
        return jsonify({"error": f"AI fallback failed: {message}"}), 500

    return jsonify({
        "job_id": job_id,
        "download_url": f"/api/download/{out_path.name}",
        "method": "ai_fallback"
    })


@app.route("/api/download/<filename>", methods=["GET"])
def download(filename):
    path = OUTPUT_DIR / filename
    if not path.exists():
        return jsonify({"error": "File not found or expired"}), 404
    return send_file(path, as_attachment=True)


# ---------------- Conversion engines ----------------

def _convert_image(src_path: Path, job_id: str, target_format: str) -> Path:
    img = Image.open(src_path)
    save_format = "JPEG" if target_format in ("jpg", "jpeg") else target_format.upper()
    if save_format == "JPEG" and img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    out_path = OUTPUT_DIR / f"{job_id}.{target_format}"
    img.save(out_path, format=save_format)
    return out_path


def _pdf_to_text(src_path: Path, job_id: str) -> Path:
    out_path = OUTPUT_DIR / f"{job_id}.txt"
    doc = fitz.open(src_path)
    text = "\n".join(page.get_text() for page in doc)
    out_path.write_text(text, encoding="utf-8")
    return out_path


def _pdf_to_images_zip(src_path: Path, job_id: str) -> Path:
    out_path = OUTPUT_DIR / f"{job_id}.zip"
    doc = fitz.open(src_path)
    with zipfile.ZipFile(out_path, "w") as zf:
        for i, page in enumerate(doc):
            pix = page.get_pixmap(dpi=150)
            img_bytes = pix.tobytes("png")
            zf.writestr(f"page_{i+1}.png", img_bytes)
    return out_path


def _pdf_to_docx(src_path: Path, job_id: str) -> Path:
    """Shells out to the Node CLI (scripts/pdf-to-docx.js), which rebuilds
    the PDF as a real .docx via docx-js rather than doing a lossy raw
    conversion. Requires node plus the Poppler/LibreOffice tools that
    script depends on to be on PATH for this process."""
    out_path = OUTPUT_DIR / f"{job_id}.docx"
    result = subprocess.run(
        # --no-verify: the LibreOffice render-back is a human review aid, pointless per web request.
        ["node", str(PDF_TO_DOCX_SCRIPT), str(src_path), str(out_path), "--no-verify"],
        capture_output=True, text=True, timeout=180,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "unknown error").strip()
        raise RuntimeError(f"pdf-to-docx.js failed: {detail}")
    return out_path


def _docx_to_text(src_path: Path, job_id: str) -> Path:
    out_path = OUTPUT_DIR / f"{job_id}.txt"
    d = docx.Document(str(src_path))
    text = "\n".join(p.text for p in d.paragraphs)
    out_path.write_text(text, encoding="utf-8")
    return out_path


def _docx_to_pdf(src_path: Path, job_id: str) -> Path:
    """High-fidelity docx -> pdf via LibreOffice (preserves layout, fonts,
    images, tables). Falls back to a basic text reflow only when LibreOffice
    isn't installed, so local dev still works without it."""
    out_path = OUTPUT_DIR / f"{job_id}.pdf"
    if SOFFICE:
        soffice_convert(src_path, out_path, "pdf")
    else:
        _docx_to_pdf_reflow(src_path, out_path)
    return out_path


def _docx_to_pdf_reflow(src_path: Path, out_path: Path) -> None:
    """Fallback: dump the document's paragraph text into a PDF. No layout,
    fonts or images - used only when LibreOffice is unavailable."""
    d = docx.Document(str(src_path))
    c = canvas.Canvas(str(out_path), pagesize=letter)
    width, height = letter
    y = height - inch
    for p in d.paragraphs:
        line = p.text
        if not line.strip():
            y -= 14
            continue
        # naive word wrap at ~95 chars
        for chunk_start in range(0, len(line), 95):
            chunk = line[chunk_start:chunk_start + 95]
            c.drawString(inch, y, chunk)
            y -= 14
            if y < inch:
                c.showPage()
                y = height - inch
    c.save()


def _txt_to_pdf(src_path: Path, job_id: str) -> Path:
    out_path = OUTPUT_DIR / f"{job_id}.pdf"
    text = src_path.read_text(encoding="utf-8", errors="ignore")
    c = canvas.Canvas(str(out_path), pagesize=letter)
    width, height = letter
    y = height - inch
    for line in text.splitlines() or [""]:
        for chunk_start in range(0, max(len(line), 1), 95):
            chunk = line[chunk_start:chunk_start + 95]
            c.drawString(inch, y, chunk)
            y -= 14
            if y < inch:
                c.showPage()
                y = height - inch
    c.save()
    return out_path


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    # Localhost-only by default: the optional AI fallback executes generated code.
    # Set HOST=0.0.0.0 deliberately if you really want it reachable on the network.
    host = os.environ.get("HOST", "127.0.0.1")
    app.run(host=host, port=port, debug=False)