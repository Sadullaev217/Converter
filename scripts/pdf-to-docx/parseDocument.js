"use strict";

/**
 * Turns Poppler's per-page layout text (plus the extracted images and,
 * when available, font/geometry data from layoutInfo.js) into a flat
 * document model that buildDocx.js can walk over.
 *
 * Structure comes from `pdftotext -layout` (monospace-aligned text, so
 * lists, tables, callouts and code are recognised by line shape). When
 * font data is available it takes over for the things text shape can't
 * tell apart: headings (size/bold relative to the body text) and code
 * (monospace fonts). Without it, the older text heuristics are used.
 *
 * It's tuned for the common case this tool targets - text + screenshots
 * technical documents - not exotic multi-column layouts.
 */

const BULLET_RE = /^(\s*)([-*•▪●○‣])\s+(.*)$/;
const NUMBERED_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const CALLOUT_WORDS = "WARNING|CAUTION|IMPORTANT|NOTE|TIP|SCREENSHOT REQUIRED";
// "Note: ..." in any case, or a shouted keyword ("WARNING ...") - but never "Notebooks are ...".
const CALLOUT_COLON_RE = new RegExp(`^(${CALLOUT_WORDS})\\s*:\\s*(.*)$`, "i");
const CALLOUT_CAPS_RE = new RegExp(`^(${CALLOUT_WORDS})(?=\\s|$)\\s*[-–—]?\\s*(.*)$`);
const FENCE_RE = /^```/;
const PAGE_NUMBER_RE = /^(?:page\s+)?\d+(?:\s*(?:of|\/)\s*\d+)?$|^[-–—]\s*\d+\s*[-–—]$/i;

const HEADING_SIZE_RATIO = 1.15; // line is a heading when this much bigger than body text
const PAGE_FILL_THRESHOLD = 0.8; // a page ending above this fraction of its height was cut short on purpose
const MAX_HEADING_LINES = 3; // a "heading-styled" run longer than this is really a paragraph

const norm = (s) => s.replace(/\s+/g, " ").trim();
const indentOf = (raw) => raw.match(/^ */)[0].length;
const roundSize = (size) => Math.round(size * 2) / 2;

function calloutMatch(text) {
  const t = text.trim();
  return t.match(CALLOUT_COLON_RE) || t.match(CALLOUT_CAPS_RE);
}

// ---------------------------------------------------------------------------
// Stage 1: annotate every layout line with its font and geometry
// ---------------------------------------------------------------------------

function queueMap(items) {
  const map = new Map();
  for (const item of items) {
    const key = norm(item.text);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

const take = (map, key) => {
  const queue = map.get(key);
  return queue && queue.length ? queue.shift() : null;
};

/**
 * Pairs each non-blank layout line with the font line and the geometry line
 * carrying the same text. Duplicates are consumed in order so repeated
 * lines stay aligned. Tables rows and other multi-column lines have no
 * single matching entry and simply get no annotation.
 */
function annotatePages(pageTexts, layoutInfo) {
  return pageTexts.map((text, idx) => {
    const info = layoutInfo ? layoutInfo.pages[idx] : null;
    const fontQueue = queueMap(info ? info.fontLines : []);
    const geomQueue = queueMap(info ? info.geomLines : []);
    const lines = text.split("\n").map((rawLine) => {
      const raw = rawLine.replace(/\s+$/, "");
      const clean = norm(raw);
      if (!clean) return { raw: "", text: "", blank: true };
      return { raw, text: clean, blank: false, font: take(fontQueue, clean), geom: take(geomQueue, clean) };
    });
    return { lines, height: info ? info.height : null, imageBoxes: info ? info.images : [] };
  });
}

// ---------------------------------------------------------------------------
// Stage 2: running headers/footers and page numbers
// ---------------------------------------------------------------------------

/**
 * Marks lines that are page furniture as removed: page numbers in the first
 * or last two lines of a page, and lines in those positions that repeat
 * (digits ignored) on at least 60% of pages. Returns how many were removed.
 */
function markRepeatedMargins(pages) {
  const keyOf = (t) => t.toLowerCase().replace(/\d+/g, "#");
  const marginsPerPage = pages.map((page) => {
    const content = page.lines.filter((l) => !l.blank);
    // Top and bottom margin windows, capped so they never overlap on a
    // short page (which would wrongly pull body lines into the margins).
    const window = Math.min(2, Math.floor(content.length / 2));
    return new Set([...content.slice(0, window), ...content.slice(content.length - window)]);
  });

  const pagesWithKey = new Map();
  marginsPerPage.forEach((margins) => {
    new Set([...margins].map((l) => keyOf(l.text))).forEach((key) => {
      pagesWithKey.set(key, (pagesWithKey.get(key) || 0) + 1);
    });
  });

  const threshold = pages.length >= 2 ? Math.max(2, Math.ceil(pages.length * 0.6)) : Infinity;
  let removed = 0;
  marginsPerPage.forEach((margins) => {
    margins.forEach((line) => {
      if (PAGE_NUMBER_RE.test(line.text) || pagesWithKey.get(keyOf(line.text)) >= threshold) {
        line.removed = true;
        removed += 1;
      }
    });
  });
  return removed;
}

// ---------------------------------------------------------------------------
// Stage 3: document-wide font statistics
// ---------------------------------------------------------------------------

function computeStats(pages) {
  const charsBySize = new Map();
  let total = 0;
  let boldChars = 0;
  let monoChars = 0;
  let withFont = 0;

  for (const page of pages) {
    for (const line of page.lines) {
      if (line.blank || line.removed || !line.font) continue;
      const chars = line.text.length;
      const size = roundSize(line.font.size);
      charsBySize.set(size, (charsBySize.get(size) || 0) + chars);
      total += chars;
      if (line.font.bold) boldChars += chars;
      if (line.font.mono) monoChars += chars;
      withFont += 1;
    }
  }

  let bodySize = 0;
  let best = -1;
  for (const [size, chars] of charsBySize) {
    if (chars > best) {
      best = chars;
      bodySize = size;
    }
  }
  const headingSizes = [...charsBySize.keys()].filter((s) => s >= bodySize * HEADING_SIZE_RATIO).sort((a, b) => b - a);

  return {
    hasFonts: withFont > 0,
    bodySize,
    headingSizes,
    mostlyBold: total > 0 && boldChars / total > 0.5,
    bodyIsMono: total > 0 && monoChars / total > 0.6,
  };
}

/** Heading level (1-3) for a font-annotated line, or null when it's body text. */
function headingLevelForFont(font, text, stats) {
  const size = roundSize(font.size);
  if (size >= stats.bodySize * HEADING_SIZE_RATIO && text.length <= 120) {
    const rank = stats.headingSizes.indexOf(size);
    return Math.min((rank < 0 ? stats.headingSizes.length : rank) + 1, 3);
  }
  if (
    font.bold &&
    !stats.mostlyBold &&
    size >= stats.bodySize * 0.95 &&
    text.length <= 80 &&
    !/[.,;:!?]$/.test(text) &&
    !BULLET_RE.test(text)
  ) {
    return Math.min(stats.headingSizes.length + 1, 3);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage 4: blocks -> nodes
// ---------------------------------------------------------------------------

function groupIntoBlocks(lines) {
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.blank || line.removed) {
      if (current.length) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

const firstY = (lines) => {
  const withGeom = lines.find((l) => l.geom);
  return withGeom ? withGeom.geom.yMin : null;
};

function classifyLine(line, ctx) {
  if (!ctx.stats.hasFonts || !line.font) return { kind: "text" };
  if (line.font.mono && !ctx.stats.bodyIsMono) return { kind: "code" };
  if (line.text.match(CALLOUT_COLON_RE)) return { kind: "text" };
  const level = headingLevelForFont(line.font, line.text, ctx.stats);
  return level ? { kind: "heading", level } : { kind: "text" };
}

/**
 * One layout block can contain several kinds of content when the source has
 * no blank lines between them (heading directly above its paragraph, a
 * code snippet inside a list...). Split wherever the style changes.
 */
function processBlock(block, ctx) {
  const segments = [];
  for (const line of block) {
    const kind = classifyLine(line, ctx);
    const last = segments[segments.length - 1];
    if (last && last.kind === kind.kind && last.level === kind.level) last.lines.push(line);
    else segments.push({ ...kind, lines: [line] });
  }

  const nodes = [];
  for (const seg of segments) {
    const y = firstY(seg.lines);
    let produced;
    if (seg.kind === "heading" && seg.lines.length <= MAX_HEADING_LINES) {
      produced = [
        {
          type: "heading",
          level: seg.level,
          text: seg.lines.map((l) => l.text).join(" "),
          pageBreakBefore: false,
        },
      ];
    } else if (seg.kind === "code") {
      produced = [{ type: "code", lines: seg.lines.map((l) => l.raw) }];
    } else {
      produced = splitTextRun(seg.lines).flatMap((run) => classifyTextRun(run, ctx));
    }
    if (produced.length) produced[0].y = y;
    nodes.push(...produced);
  }
  return nodes;
}

function lineType(raw) {
  if (calloutMatch(raw)) return "callout";
  if (BULLET_RE.test(raw)) return "bullet";
  if (NUMBERED_RE.test(raw)) return "numbered";
  return "plain";
}

/**
 * Splits a run of body-text lines where a new structure begins: a callout
 * keyword, a list starting after a paragraph, or a switch between bullet and
 * numbered lists. Deeper-indented items stay with their parent (nested list).
 */
function splitTextRun(lines) {
  const runs = [];
  let cur = null;
  for (const line of lines) {
    const type = lineType(line.raw);
    const indent = indentOf(line.raw);
    const isListLine = type === "bullet" || type === "numbered";

    // A callout is kept to its own single line: the keyword marks a boxed
    // note, and the sentence after it is ordinarily a normal paragraph, not
    // more callout text. Merging it in is worse than splitting a rare
    // wrapped callout, so always break before and after a callout line.
    let startNew = !cur || type === "callout" || cur.type === "callout";
    if (!startNew && isListLine) {
      if (cur.type === "plain") startNew = true;
      else if (type !== cur.type && indent <= cur.indent) startNew = true;
    }

    if (startNew) {
      cur = { type, indent, lines: [line] };
      runs.push(cur);
    } else {
      cur.lines.push(line);
    }
  }
  return runs.map((r) => r.lines);
}

function classifyTextRun(lines, ctx) {
  const first = lines[0];

  const callout = calloutMatch(first.text);
  if (callout) return [buildCalloutNode(callout, lines)];

  if (FENCE_RE.test(first.text)) {
    const codeLines = [];
    for (let i = 1; i < lines.length; i++) {
      if (FENCE_RE.test(lines[i].text)) break;
      codeLines.push(lines[i].raw);
    }
    return [{ type: "code", lines: codeLines }];
  }

  // Without font data, fall back to indentation / line-shape heuristics.
  if (!ctx.stats.hasFonts) {
    if (lines.length >= 2 && lines.every((l) => /^ {4,}\S/.test(l.raw))) {
      return [{ type: "code", lines: lines.map((l) => l.raw) }];
    }
    if (lines.length === 1) {
      const level = headingLevelFromText(first.text);
      if (level) return [{ type: "heading", level, text: first.text, pageBreakBefore: false }];
    }
  }

  const tableRows = detectTable(lines);
  if (tableRows) return [{ type: "table", rows: tableRows }];

  const type = lineType(first.raw);
  if (type === "bullet" || type === "numbered") {
    ctx.listIdRef.value += 1;
    return parseListBlock(lines, ctx.listIdRef.value);
  }

  const text = lines.map((l) => l.text).join(" ");
  return text ? [{ type: "paragraph", text }] : [];
}

function buildCalloutNode(match, lines) {
  const label = match[1].toUpperCase();
  const kind = label.startsWith("SCREENSHOT")
    ? "screenshot"
    : label === "WARNING" || label === "CAUTION"
      ? "warning"
      : label === "IMPORTANT"
        ? "important"
        : label === "TIP"
          ? "tip"
          : "note";
  const text = [match[2], ...lines.slice(1).map((l) => l.text)].filter(Boolean).join(" ");
  return { type: "callout", kind, label, text };
}

// Detects a table from the monospace-aligned `-layout` text by finding the
// columns' start positions, then assigning each line's text to columns by
// character position. Crucially this handles multi-line cells: a line whose
// left column is empty (the right cell wrapped) is folded into the row above,
// and a short lowercase spillover in the left column (a wrapped left cell) is
// too. Returns an array of row arrays, or null when it isn't tabular.
function detectTable(lines) {
  const raws = lines.map((l) => l.raw.replace(/\s+$/, "")).filter((r) => r.trim());
  if (raws.length < 2) return null;

  const leftMargin = Math.min(...raws.map((r) => r.length - r.trimStart().length));

  // Column boundaries = start positions that recur across lines: the left
  // margin, plus any field that begins after a run of 2+ spaces.
  const freq = new Map();
  for (const r of raws) {
    const starts = new Set();
    if (r.length - r.trimStart().length <= leftMargin + 1) starts.add(leftMargin);
    const re = /\s{2,}\S/g;
    let m;
    while ((m = re.exec(r))) starts.add(m.index + m[0].length - 1);
    starts.forEach((c) => freq.set(c, (freq.get(c) || 0) + 1));
  }
  let bounds = [...freq.entries()].filter(([, n]) => n >= 2).map(([c]) => c).sort((a, b) => a - b);
  bounds = bounds.filter((c, i) => i === 0 || c - bounds[i - 1] > 3); // merge near-duplicates
  if (bounds.length < 2) return null;

  const cut = (r) => bounds.map((b, i) => (r.slice(b, i + 1 < bounds.length ? bounds[i + 1] : r.length) || "").trim());

  const rows = [];
  for (const r of raws) {
    const cells = cut(r);
    const left = cells[0];
    // Continuation of the row above when the left cell is empty, or a short
    // lowercase fragment (a wrapped left cell like "something").
    const isContinuation =
      rows.length > 0 && (left === "" || (/^[a-z]/.test(left) && left.length <= 18 && left.split(/\s+/).length <= 2));
    if (isContinuation) {
      const last = rows[rows.length - 1];
      cells.forEach((c, i) => {
        if (c) last[i] = last[i] ? `${last[i]} ${c}` : c;
      });
    } else {
      rows.push(cells);
    }
  }

  const solidRows = rows.filter((r) => r.filter(Boolean).length >= 2).length;
  if (rows.length < 2 || solidRows < 2) return null;
  return rows;
}

/** Text-only heading guess, used when no font data is available. */
function headingLevelFromText(rawLine) {
  const line = rawLine.trim();
  if (!line || line.length > 80) return null;

  if (/^(chapter|section|part)\s+\d+/i.test(line)) return 1;
  if (/^\d+(\.\d+){0,3}\.?\s+\S/.test(line)) return 2;

  const letters = line.replace(/[^A-Za-z]/g, "");
  const hasTrailingPunctuation = /[.,;:]$/.test(line);
  if (letters.length >= 3 && line === line.toUpperCase() && !hasTrailingPunctuation) {
    return 1;
  }

  const words = line.split(/\s+/);
  if (words.length >= 2 && words.length <= 12 && !hasTrailingPunctuation) {
    const minorWords = /^(a|an|the|of|and|or|for|to|in|on|with|vs\.?)$/i;
    const looksTitleCased = words.every(
      (w, i) => /^[A-Z][A-Za-z0-9'-]*$/.test(w) || /^[A-Z0-9][A-Z0-9-]*$/.test(w) || (i > 0 && minorWords.test(w)),
    );
    if (looksTitleCased) return 2;
  }

  return null;
}

function parseListBlock(lines, listId) {
  const raws = lines.map((l) => l.raw);
  const baseIndent = Math.min(
    ...raws.filter((r) => BULLET_RE.test(r) || NUMBERED_RE.test(r)).map(indentOf),
  );
  const levelOf = (indent) => Math.min(Math.max(Math.floor((indent - baseIndent) / 2), 0), 3);

  const items = [];
  let current = null;
  for (const raw of raws) {
    const bulletMatch = raw.match(BULLET_RE);
    const numberedMatch = raw.match(NUMBERED_RE);
    if (bulletMatch) {
      current = { type: "bullet", level: levelOf(bulletMatch[1].length), text: norm(bulletMatch[3]) };
      items.push(current);
    } else if (numberedMatch) {
      current = { type: "numbered", level: levelOf(numberedMatch[1].length), text: norm(numberedMatch[3]), listId };
      items.push(current);
    } else if (current) {
      current.text += ` ${norm(raw)}`;
    } else {
      items.push({ type: "paragraph", text: norm(raw) });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Stage 5: page-level assembly (page breaks, image placement, code merging)
// ---------------------------------------------------------------------------

/** How far down the page the last kept line reaches (0-1), or null if unknown. */
function pageFill(page) {
  if (!page.height) return null;
  const ys = page.lines.filter((l) => !l.blank && !l.removed && l.geom).map((l) => l.geom.yMax);
  return ys.length ? Math.max(...ys) / page.height : null;
}

/**
 * Honour a "new section starts on a new page" layout: a top-level heading
 * opening a PDF page gets a page break, but only if the previous page was
 * left short on purpose (otherwise the heading just landed there by flow).
 */
function applyPageBreak(firstNode, previousPage) {
  if (!firstNode || firstNode.type !== "heading") return;
  const fill = pageFill(previousPage);
  firstNode.pageBreakBefore = fill !== null ? firstNode.level <= 2 && fill < PAGE_FILL_THRESHOLD : firstNode.level === 1;
}

/** Interleaves image nodes with a page's text nodes by vertical position. */
function placeImages(pageNodes, imageItems) {
  const placed = imageItems.filter((i) => i.top !== null).sort((a, b) => a.top - b.top);
  const unplaced = imageItems.filter((i) => i.top === null);
  const out = [];
  let next = 0;
  for (const node of pageNodes) {
    if (node.y !== undefined && node.y !== null) {
      while (next < placed.length && placed[next].top <= node.y) out.push(placed[next++].node);
    }
    out.push(node);
  }
  while (next < placed.length) out.push(placed[next++].node);
  unplaced.forEach((i) => out.push(i.node));
  return out;
}

/** Merges adjacent code nodes (a snippet split by a stray blank line) and removes common indentation. */
function finalizeCode(nodes) {
  const out = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (node.type === "code" && prev && prev.type === "code") prev.lines.push(...node.lines);
    else out.push(node.type === "code" ? { ...node, lines: [...node.lines] } : node);
  }
  for (const node of out) {
    if (node.type !== "code") continue;
    const indents = node.lines.filter((l) => l.trim()).map(indentOf);
    const min = indents.length ? Math.min(...indents) : 0;
    node.lines = node.lines.map((l) => l.slice(Math.min(min, l.length)));
  }
  return out;
}

/**
 * @param {string[]} pageTexts   per-page `pdftotext -layout` text
 * @param {Array}    images      from extractImages(): { file, page, ordinal, pageImageCount }
 * @param {object}   [layoutInfo] from extractLayoutInfo(); omit for text-only heuristics
 */
function parseDocument(pageTexts, images, layoutInfo) {
  const info = layoutInfo && layoutInfo.usable ? layoutInfo : null;
  const pages = annotatePages(pageTexts, info);
  const removedLines = markRepeatedMargins(pages);
  const stats = computeStats(pages);
  const ctx = { stats, listIdRef: { value: 0 } };

  let nodes = [];
  pages.forEach((page, idx) => {
    let pageNodes = groupIntoBlocks(page.lines).flatMap((block) => processBlock(block, ctx));
    if (idx > 0) applyPageBreak(pageNodes[0], pages[idx - 1]);

    const pageNo = idx + 1;
    const imageItems = images
      .filter((img) => img.page === pageNo)
      .map((img) => {
        const box = page.imageBoxes.length === img.pageImageCount ? page.imageBoxes[img.ordinal] : null;
        return { node: { type: "image", file: img.file }, top: box ? box.top : null };
      });
    pageNodes = placeImages(pageNodes, imageItems);
    nodes.push(...pageNodes);
  });

  images
    .filter((img) => img.page === null || img.page === undefined)
    .forEach((img) => nodes.push({ type: "image", file: img.file }));

  nodes = finalizeCode(nodes);
  return { nodes, stats: { removedLines, usedFonts: stats.hasFonts, bodySize: stats.bodySize } };
}

module.exports = {
  parseDocument,
  // exported for unit tests
  _internal: { calloutMatch, detectTable, splitTextRun, headingLevelFromText, markRepeatedMargins, annotatePages, finalizeCode, placeImages },
};
