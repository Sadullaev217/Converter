"""
AI Fallback Conversion Engine (Gemini edition)
================================================
When no hardcoded engine exists for a (source_format, target_format) pair,
this module asks Google Gemini (free tier) to WRITE a small Python
conversion script on the fly, then runs that script in a subprocess to
actually perform the conversion.

Get a free API key at https://aistudio.google.com/apikey (no credit card
required for the free tier).

SAFETY NOTE: this executes AI-generated code locally. That's fine for a
personal/local tool you run yourself, but you should NOT expose this
endpoint on the public internet without a proper sandbox (e.g. Docker
container with no network access, resource limits, timeouts). Treat this
as a desktop/local-only feature.

Setup:
  pip install requests
  set the GEMINI_API_KEY environment variable (get one at
  https://aistudio.google.com/apikey)
"""

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import requests

MODEL = "gemini-2.5-flash"
GEMINI_API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
TIMEOUT_SECONDS = 60

SYSTEM_PROMPT = """You are a code generator for a local file-conversion tool.
Given a source file path, a source format, and a target format, write a
single self-contained Python script that converts the source file to the
target format and saves the result to a given output path.

Rules:
- Output ONLY raw Python code. No markdown fences, no explanation, no preamble.
- The script must be runnable as-is with `python3 script.py`.
- Read the source path from sys.argv[1] and write to sys.argv[2].
- Only use these libraries if needed (assume they are installed), using
  EXACTLY these import statements (the pip package name and import name
  differ for some of these, do not guess):
    from PIL import Image
    import fitz                  # this is PyMuPDF, NOT "import pymupdf" or "from PyMuPDF import fitz"
    import docx                  # this is python-docx
    import pptx                  # this is python-pptx
    import openpyxl
    from reportlab.pdfgen import canvas
    import pandas as pd
    from lxml import etree
    from bs4 import BeautifulSoup  # this is beautifulsoup4
  Use Python standard library otherwise.
- Do not access the network. Do not read or write any path other than
  sys.argv[1] and sys.argv[2].
- Keep the script under 100 lines.
- CONTENT FIDELITY IS CRITICAL: extract ALL text content from the source
  file (every paragraph, heading, table cell, slide, etc. -- do not skip,
  truncate, or summarize anything) and write ALL of it into the target
  file. Preserve structure where possible: paragraph breaks should stay as
  paragraph breaks, table rows should stay as table rows, separate
  pages/slides should stay separate. The goal is that someone reading the
  converted file gets the same information as the original, not a
  shortened or approximate version.
- If the conversion is not feasible with these libraries, write a script
  that prints an error to stderr and exits with code 1 instead of guessing.
"""


def ai_convert(src_path: Path, source_format: str, target_format: str, out_path: Path) -> tuple[bool, str]:
    """
    Asks Gemini to generate a conversion script for this specific format
    pair, then executes it. Returns (success, message).
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return False, "GEMINI_API_KEY environment variable is not set."

    user_prompt = (
        f"Source format: {source_format}\n"
        f"Target format: {target_format}\n"
        f"Write the conversion script now."
    )

    try:
        response = requests.post(
            f"{GEMINI_API_URL}?key={api_key}",
            headers={"Content-Type": "application/json"},
            json={
                "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
                "generationConfig": {
                    "temperature": 0,
                    "maxOutputTokens": 4096,
                    "thinkingConfig": {"thinkingBudget": 0},
                },
            },
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()
        candidate = data["candidates"][0]
        finish_reason = candidate.get("finishReason", "")
        if finish_reason == "MAX_TOKENS":
            return False, "Gemini response was cut off (ran out of output tokens) before finishing the script."
        code = candidate["content"]["parts"][0]["text"].strip()
    except Exception as e:
        return False, f"Gemini API call failed: {e}"

    # Strip accidental markdown fences just in case
    code = re.sub(r"^```(?:python)?\n", "", code)
    code = re.sub(r"\n```$", "", code)

    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write(code)
        script_path = f.name

    try:
        result = subprocess.run(
            [sys.executable, script_path, str(src_path), str(out_path)],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return False, "AI-generated conversion script timed out."
    finally:
        os.unlink(script_path)

    if result.returncode != 0:
        return False, f"Generated script failed: {result.stderr[-500:]}"

    if not out_path.exists():
        return False, "Script ran but did not produce an output file."

    return True, "Converted via AI-generated script (Gemini)."