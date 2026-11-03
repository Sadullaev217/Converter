"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveTool, toolPath } = require("./checkDeps");

/**
 * Structured layout data that plain `pdftotext -layout` can't provide:
 *
 *   - pdftohtml -xml      -> per-line font size, bold and family, plus the
 *                            boxes of embedded images. Its *text* `top`
 *                            values are unreliable, so only fonts and image
 *                            boxes are taken from it.
 *   - pdftotext -bbox-layout -> per-line bounding boxes in points, used to
 *                            place images between the right paragraphs and
 *                            to tell whether a page was filled.
 *
 * Everything here is best-effort: on any failure the caller falls back to
 * the text-only heuristics in parseDocument.js.
 */

const ZOOM = 2; // pdftohtml -zoom factor; sizes/coordinates are divided back by it

const MONO_RE = /courier|consolas|menlo|monaco|monospace|mono(?![a-z])|inconsolata|lucida\s*console|cascadia|fira\s*code|jetbrains|source\s*code/i;
const BOLD_RE = /bold|black|heavy/i;

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (match, entity) => {
    const e = entity.toLowerCase();
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  });
}

const stripTags = (s) => s.replace(/<[^>]+>/g, "");

/** Parses the XML written by `pdftohtml -xml` into per-page font lines and image boxes. */
function parseHtmlXml(xml) {
  const fonts = new Map();
  const fontRe = /<fontspec\b[^>]*\bid="(\d+)"[^>]*\bsize="([\d.]+)"[^>]*\bfamily="([^"]*)"/g;
  let m;
  while ((m = fontRe.exec(xml))) {
    fonts.set(m[1], { size: parseFloat(m[2]) / ZOOM, family: m[3] });
  }

  const pages = [];
  const pageRe = /<page\b[^>]*\bnumber="(\d+)"[^>]*>([\s\S]*?)<\/page>/g;
  while ((m = pageRe.exec(xml))) {
    const body = m[2];
    const fontLines = [];
    const textRe = /<text\b[^>]*\bfont="(\d+)"[^>]*>([\s\S]*?)<\/text>/g;
    let t;
    while ((t = textRe.exec(body))) {
      const font = fonts.get(t[1]);
      if (!font) continue;
      const inner = t[2];
      const text = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
      if (!text) continue;
      const boldChars = (inner.match(/<b>[\s\S]*?<\/b>/g) || []).map((s) => stripTags(s)).join("").trim().length;
      const bold = BOLD_RE.test(font.family) || boldChars >= 0.8 * stripTags(inner).trim().length;
      fontLines.push({ text, size: font.size, bold, mono: MONO_RE.test(font.family) });
    }

    const images = [];
    const imgRe = /<image\b[^>]*\btop="(-?\d+)"[^>]*\bheight="(\d+)"/g;
    let im;
    while ((im = imgRe.exec(body))) {
      images.push({ top: parseInt(im[1], 10) / ZOOM, height: parseInt(im[2], 10) / ZOOM });
    }

    pages[parseInt(m[1], 10) - 1] = { fontLines, images };
  }
  return pages;
}

/** Parses `pdftotext -bbox-layout` XHTML into per-page line boxes (points). */
function parseBboxLayout(html) {
  const pages = [];
  const pageRe = /<page\b[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"[^>]*>([\s\S]*?)<\/page>/g;
  let m;
  while ((m = pageRe.exec(html))) {
    const geomLines = [];
    const lineRe = /<line\b[^>]*\bxMin="([\d.]+)"[^>]*\byMin="([\d.]+)"[^>]*\byMax="([\d.]+)"[^>]*>([\s\S]*?)<\/line>/g;
    let l;
    while ((l = lineRe.exec(m[3]))) {
      const words = [...l[4].matchAll(/<word\b[^>]*>([\s\S]*?)<\/word>/g)].map((w) => decodeEntities(w[1]));
      const text = words.join(" ").replace(/\s+/g, " ").trim();
      if (text) geomLines.push({ text, xMin: parseFloat(l[1]), yMin: parseFloat(l[2]), yMax: parseFloat(l[3]) });
    }
    pages.push({ height: parseFloat(m[2]), geomLines });
  }
  return pages;
}

/**
 * Returns { pages: [{ fontLines, images, geomLines, height }], warnings }, or
 * null when neither source could be read. `pages` has one entry per PDF page.
 */
function extractLayoutInfo(pdfPath, tmpDir) {
  const warnings = [];
  let fontPages = [];
  let geomPages = [];

  if (resolveTool("pdftohtml")) {
    const outRoot = path.join(tmpDir, "layout");
    const run = spawnSync(toolPath("pdftohtml"), ["-xml", "-q", "-nodrm", "-zoom", String(ZOOM), pdfPath, outRoot], {
      encoding: "utf8",
    });
    const xmlPath = `${outRoot}.xml`;
    if (run.status === 0 && fs.existsSync(xmlPath)) {
      fontPages = parseHtmlXml(fs.readFileSync(xmlPath, "utf8"));
    } else {
      warnings.push("pdftohtml failed; font-based detection disabled");
    }
  } else {
    warnings.push("pdftohtml not found; font-based detection disabled (install the full Poppler utilities)");
  }

  const bboxPath = path.join(tmpDir, "bbox.html");
  const bbox = spawnSync(toolPath("pdftotext"), ["-bbox-layout", pdfPath, bboxPath], { encoding: "utf8" });
  if (bbox.status === 0 && fs.existsSync(bboxPath)) {
    geomPages = parseBboxLayout(fs.readFileSync(bboxPath, "utf8"));
  } else {
    warnings.push("pdftotext -bbox-layout failed; image placement falls back to end-of-page");
  }

  const pageCount = Math.max(fontPages.length, geomPages.length);
  if (pageCount === 0) return { pages: [], warnings, usable: false };

  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    const f = fontPages[i] || { fontLines: [], images: [] };
    const g = geomPages[i] || { height: null, geomLines: [] };
    pages.push({ fontLines: f.fontLines, images: f.images, geomLines: g.geomLines, height: g.height });
  }
  return { pages, warnings, usable: true };
}

module.exports = { extractLayoutInfo, parseHtmlXml, parseBboxLayout };
