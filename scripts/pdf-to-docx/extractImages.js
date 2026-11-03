"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { toolPath } = require("./checkDeps");

/**
 * Extracts every embedded image from the PDF as PNG files in `tmpDir`,
 * and figures out which source page each one came from.
 *
 * `pdfimages -list` prints one row per image, in the same order that
 * `pdfimages -png` extracts them, so the Nth list row corresponds to the
 * Nth extracted file. We zip them together to recover page numbers.
 *
 * The list also contains soft masks / stencil masks (type "smask", "mask",
 * "stencil"): those are alpha channels, not pictures, so they're dropped.
 *
 * Returns: [{ file, page, ordinal, pageImageCount }, ...] where `ordinal` is
 * the image's index among the real images on its page and `pageImageCount`
 * how many there are on that page (used to pair them with image boxes).
 */
function extractImages(pdfPath, tmpDir) {
  const listResult = spawnSync(toolPath("pdfimages"), ["-list", pdfPath], { encoding: "utf8" });
  if (listResult.status !== 0) {
    throw new Error(`pdfimages -list failed: ${listResult.stderr || listResult.error}`);
  }

  const rows = parseImageList(listResult.stdout);

  const prefix = path.join(tmpDir, "img");
  const extractResult = spawnSync(toolPath("pdfimages"), ["-png", pdfPath, prefix], { encoding: "utf8" });
  if (extractResult.status !== 0) {
    throw new Error(`pdfimages -png failed: ${extractResult.stderr || extractResult.error}`);
  }

  const files = fs
    .readdirSync(tmpDir)
    .filter((name) => name.startsWith("img-") && name.endsWith(".png"))
    .sort()
    .map((name) => path.join(tmpDir, name));

  if (files.length !== rows.length) {
    // Fall back to "unknown page" rather than mis-attributing images.
    return files.map((file) => ({ file, page: null, ordinal: null, pageImageCount: null }));
  }

  const kept = files.map((file, i) => ({ file, page: rows[i].page, type: rows[i].type })).filter((x) => x.type === "image");
  const perPage = new Map();
  kept.forEach((x) => perPage.set(x.page, (perPage.get(x.page) || 0) + 1));
  const seen = new Map();
  return kept.map((x) => {
    const ordinal = seen.get(x.page) || 0;
    seen.set(x.page, ordinal + 1);
    return { file: x.file, page: x.page, ordinal, pageImageCount: perPage.get(x.page) };
  });
}

/**
 * Parses `page` and `type` out of `pdfimages -list` output. The table has
 * a two-line header (column names, then a "---" separator) followed by
 * one whitespace-aligned row per image.
 */
function parseImageList(listOutput) {
  const lines = listOutput.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines
    .slice(2) // skip header + separator
    .map((line) => line.trim().match(/^(\d+)\s+\d+\s+(\S+)/))
    .filter(Boolean)
    .map((m) => ({ page: parseInt(m[1], 10), type: m[2] }));
}

/**
 * Drops pictures that repeat on most pages (logos in a running header or
 * footer). Needs at least 3 pages, and the same bytes on >= 60% of them.
 * Returns { kept, dropped }.
 */
function dropRepeatedImages(images, pageCount) {
  if (pageCount < 3) return { kept: images, dropped: [] };

  const pagesByHash = new Map();
  const hashOf = new Map();
  for (const img of images) {
    const hash = crypto.createHash("md5").update(fs.readFileSync(img.file)).digest("hex");
    hashOf.set(img, hash);
    if (!pagesByHash.has(hash)) pagesByHash.set(hash, new Set());
    pagesByHash.get(hash).add(img.page);
  }

  const threshold = Math.max(3, Math.ceil(pageCount * 0.6));
  const kept = [];
  const dropped = [];
  for (const img of images) {
    (pagesByHash.get(hashOf.get(img)).size >= threshold ? dropped : kept).push(img);
  }
  return { kept, dropped };
}

module.exports = { extractImages, dropRepeatedImages, parseImageList };
