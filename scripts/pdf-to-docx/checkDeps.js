"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// LibreOffice's Windows installer doesn't add soffice.exe to PATH.
const FALLBACK_LOCATIONS = {
  soffice: [
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  ],
};

const resolved = {};

// The Poppler suite ships these together. We anchor on whichever resolves
// first and prefer its siblings for the rest, so a stray Xpdf `pdftotext`
// earlier on PATH can't shadow Poppler's (Xpdf lacks -bbox-layout and the
// -xml output we rely on).
const POPPLER_TOOLS = ["pdfimages", "pdftotext", "pdftohtml", "pdftoppm"];
let popplerDir;

/**
 * Finds an executable on PATH without launching it (soffice is slow to
 * start). Returns its absolute path, or null.
 */
function findOnPath(command) {
  const isWin = process.platform === "win32";
  const result = isWin
    ? spawnSync("where", [command], { encoding: "utf8" })
    : spawnSync("command", ["-v", command], { encoding: "utf8", shell: true });
  if (result.status !== 0) return null;
  const first = (result.stdout || "").split(/\r?\n/).find((l) => l.trim());
  return first ? first.trim() : null;
}

function popplerBinDir() {
  if (popplerDir !== undefined) return popplerDir;
  // Prefer the directory of the first Poppler tool that has pdftohtml as a
  // sibling (Xpdf's pdfimages/pdftoppm do too, but we just want one dir that
  // offers the whole suite; the winget Poppler install does).
  for (const tool of POPPLER_TOOLS) {
    const hit = findOnPath(tool);
    if (hit) {
      const dir = path.dirname(hit);
      const ext = process.platform === "win32" ? ".exe" : "";
      if (fs.existsSync(path.join(dir, `pdftohtml${ext}`)) && fs.existsSync(path.join(dir, `pdfimages${ext}`))) {
        popplerDir = dir;
        return popplerDir;
      }
    }
  }
  popplerDir = null;
  return popplerDir;
}

function resolveTool(command) {
  if (resolved[command] !== undefined) return resolved[command];
  let found = null;
  if (POPPLER_TOOLS.includes(command)) {
    const dir = popplerBinDir();
    const ext = process.platform === "win32" ? ".exe" : "";
    if (dir && fs.existsSync(path.join(dir, `${command}${ext}`))) {
      found = path.join(dir, `${command}${ext}`);
    }
  }
  if (!found) found = findOnPath(command);
  if (!found && process.platform === "win32") {
    found = (FALLBACK_LOCATIONS[command] || []).find((p) => fs.existsSync(p)) || null;
  }
  resolved[command] = found;
  return found;
}

/** Path to use when spawning `command` (falls back to the bare name). */
function toolPath(command) {
  return resolveTool(command) || command;
}

const REQUIRED_TOOLS = [
  { command: "pdfimages", purpose: "extracting embedded images (Poppler)" },
  { command: "pdftotext", purpose: "extracting text and layout (Poppler)" },
];

const VERIFY_TOOLS = [
  { command: "pdftoppm", purpose: "rendering verification page images (Poppler)" },
  { command: "soffice", purpose: "rendering the .docx back to PDF for verification (LibreOffice)" },
];

/**
 * Verifies every required external tool is available. Verification tools
 * (soffice, pdftoppm) are only required when `verify` is true. Throws one
 * formatted error listing everything missing, with install hints.
 */
function requireTools({ verify = true } = {}) {
  const needed = verify ? [...REQUIRED_TOOLS, ...VERIFY_TOOLS] : REQUIRED_TOOLS;
  const missing = needed.filter((tool) => !resolveTool(tool.command));
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
    "Tip: pass --no-verify to skip the LibreOffice/pdftoppm verification step.",
  ];
  throw new Error(lines.join("\n"));
}

module.exports = { requireTools, resolveTool, toolPath };
