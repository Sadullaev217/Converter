"use strict";

const { spawnSync } = require("child_process");

/**
 * Checks whether an executable is resolvable on PATH without actually
 * launching it (important for soffice, which is slow to start).
 */
function isOnPath(command) {
  const finder = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const result = spawnSync(finder, args, { stdio: "ignore", shell: process.platform !== "win32" });
  return result.status === 0;
}

const REQUIRED_TOOLS = [
  { command: "pdfimages", purpose: "extracting embedded images (Poppler)" },
  { command: "pdftotext", purpose: "extracting text and layout (Poppler)" },
  { command: "pdftoppm", purpose: "rendering verification page images (Poppler)" },
  { command: "soffice", purpose: "rendering the .docx back to PDF for verification (LibreOffice)" },
];

/**
 * Verifies every required external tool is on PATH. Throws a single
 * formatted error listing everything missing, with install hints for
 * Windows and Debian/Ubuntu, so the caller can print it and exit non-zero.
 */
function requireTools() {
  const missing = REQUIRED_TOOLS.filter((tool) => !isOnPath(tool.command));
  if (missing.length === 0) return;

  const lines = [
    "Missing required command-line tools:",
    ...missing.map((tool) => `  - ${tool.command} (needed for ${tool.purpose})`),
    "",
    "Install them, then re-run this script:",
    "  Windows (winget):  winget install oschwartz10612.Poppler ; winget install TheDocumentFoundation.LibreOffice",
    "  Windows (choco):   choco install poppler libreoffice-fresh -y",
    "  Debian/Ubuntu:     sudo apt-get install poppler-utils libreoffice",
    "  macOS (brew):      brew install poppler ; brew install --cask libreoffice",
    "",
    "Note: LibreOffice's Windows installer does not add soffice.exe to PATH automatically.",
    'Add "C:\\Program Files\\LibreOffice\\program" to your PATH if soffice is still not found after installing.',
  ];
  throw new Error(lines.join("\n"));
}

module.exports = { requireTools, isOnPath };
