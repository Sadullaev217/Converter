"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/**
 * Extracts every embedded image from the PDF as PNG files in `tmpDir`,
 * and figures out which source page each one came from.
 *
 * `pdfimages -list` prints one row per image, in the same order that
 * `pdfimages -png` extracts them, so the Nth list row corresponds to the
 * Nth extracted file. We zip them together to recover page numbers.
 *
 * Returns: [{ file: <absolute path>, page: <1-based page number> }, ...]
 */
function extractImages(pdfPath, tmpDir) {
  const listResult = spawnSync("pdfimages", ["-list", pdfPath], { encoding: "utf8" });
  if (listResult.status !== 0) {
    throw new Error(`pdfimages -list failed: ${listResult.stderr || listResult.error}`);
  }

  const pages = parseImageListPages(listResult.stdout);

  const prefix = path.join(tmpDir, "img");
  const extractResult = spawnSync("pdfimages", ["-png", pdfPath, prefix], { encoding: "utf8" });
  if (extractResult.status !== 0) {
    throw new Error(`pdfimages -png failed: ${extractResult.stderr || extractResult.error}`);
  }

  const files = fs
    .readdirSync(tmpDir)
    .filter((name) => name.startsWith("img-") && name.endsWith(".png"))
    .sort()
    .map((name) => path.join(tmpDir, name));

  if (files.length !== pages.length) {
    // Fall back to "unknown page" rather than mis-attributing images.
    return files.map((file) => ({ file, page: null }));
  }

  return files.map((file, i) => ({ file, page: pages[i] }));
}

/**
 * Parses the `page` column out of `pdfimages -list` output. The table has
 * a two-line header (column names, then a "---" separator) followed by
 * one whitespace-aligned row per image.
 */
function parseImageListPages(listOutput) {
  const lines = listOutput.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const dataLines = lines.slice(2); // skip header + separator
  return dataLines
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s/);
      return match ? parseInt(match[1], 10) : null;
    })
    .filter((page) => page !== null);
}

module.exports = { extractImages };
