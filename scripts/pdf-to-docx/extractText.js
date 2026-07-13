"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/**
 * Runs `pdftotext -layout` and splits the result into per-page text,
 * using the form-feed character Poppler inserts between pages.
 * Returns an array of raw page strings, 1 entry per PDF page.
 */
function extractPageTexts(pdfPath, tmpDir) {
  const textPath = path.join(tmpDir, "text.txt");
  const result = spawnSync("pdftotext", ["-layout", pdfPath, textPath], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`pdftotext failed: ${result.stderr || result.error}`);
  }

  const raw = fs.readFileSync(textPath, "utf8");
  const pages = raw.split("\f");
  // pdftotext emits a trailing form feed, leaving one empty page at the end.
  if (pages.length > 1 && pages[pages.length - 1].trim() === "") {
    pages.pop();
  }
  return pages;
}

module.exports = { extractPageTexts };
