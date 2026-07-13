"use strict";

/**
 * Turns Poppler's per-page layout text (plus the extracted image list)
 * into a rough, flat document model that buildDocx.js can walk over.
 *
 * This is heuristic, not a real PDF layout parser: pdftotext -layout gives
 * us monospace-aligned text with no font/size/boldness metadata, so
 * headings, lists, tables, code and callouts are all detected from line
 * shape (indentation, casing, punctuation, repeated markers). It's tuned
 * for the common case this tool targets - text + screenshots technical
 * documents - not exotic multi-column layouts. Adjust the regexes below
 * if the PDFs you run this against use different conventions.
 */

const BULLET_RE = /^(\s*)([-*•▪●○‣])\s+(.*)$/;
const NUMBERED_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const CALLOUT_RE = /^(WARNING|CAUTION|IMPORTANT|NOTE|TIP|SCREENSHOT REQUIRED)\s*[:\-]?\s*(.*)$/i;
const FENCE_RE = /^```/;

function parseDocument(pageTexts, images) {
  const nodes = [];
  const listIdRef = { value: 0 };

  pageTexts.forEach((pageText, idx) => {
    const pageNum = idx + 1;
    const lines = pageText.split("\n");
    const blocks = groupIntoBlocks(lines);

    blocks.forEach((block, blockIdx) => {
      const isFirstBlockOnPage = blockIdx === 0 && pageNum > 1;
      nodes.push(...classifyBlock(block, isFirstBlockOnPage, listIdRef));
    });

    images
      .filter((img) => img.page === pageNum)
      .forEach((img) => nodes.push({ type: "image", file: img.file }));
  });

  images
    .filter((img) => img.page === null || img.page === undefined)
    .forEach((img) => nodes.push({ type: "image", file: img.file }));

  return nodes;
}

function groupIntoBlocks(lines) {
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length) {
        blocks.push(current);
        current = [];
      }
    } else {
      current.push(line.replace(/\s+$/, ""));
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function classifyBlock(lines, isFirstBlockOnPage, listIdRef) {
  if (lines.length === 0) return [];

  const calloutMatch = lines[0].trim().match(CALLOUT_RE);
  if (calloutMatch) {
    return [buildCalloutNode(calloutMatch, lines)];
  }

  if (FENCE_RE.test(lines[0].trim())) {
    const codeLines = [];
    for (let i = 1; i < lines.length; i++) {
      if (FENCE_RE.test(lines[i].trim())) break;
      codeLines.push(lines[i]);
    }
    return [{ type: "code", lines: codeLines }];
  }

  if (lines.length >= 2 && lines.every((l) => /^ {4,}\S/.test(l))) {
    return [{ type: "code", lines: lines.map((l) => l.replace(/^ {4}/, "")) }];
  }

  const tableRows = detectTable(lines);
  if (tableRows) {
    return [{ type: "table", rows: tableRows }];
  }

  if (lines.length === 1) {
    const level = headingLevel(lines[0]);
    if (level) {
      return [
        {
          type: "heading",
          level,
          text: lines[0].trim(),
          pageBreakBefore: Boolean(isFirstBlockOnPage && level === 1),
        },
      ];
    }
  }

  if (BULLET_RE.test(lines[0]) || NUMBERED_RE.test(lines[0])) {
    listIdRef.value += 1;
    return parseListBlock(lines, listIdRef.value);
  }

  const text = lines.map((l) => l.trim()).filter(Boolean).join(" ");
  return text ? [{ type: "paragraph", text }] : [];
}

function buildCalloutNode(calloutMatch, lines) {
  const label = calloutMatch[1].toUpperCase();
  const kind = label.startsWith("SCREENSHOT")
    ? "screenshot"
    : label === "WARNING" || label === "CAUTION"
      ? "warning"
      : label === "IMPORTANT"
        ? "important"
        : label === "TIP"
          ? "tip"
          : "note";
  const rest = [calloutMatch[2], ...lines.slice(1).map((l) => l.trim())].filter(Boolean).join(" ");
  return { type: "callout", kind, label, text: rest };
}

// A block is a table if every line splits into the same number (>=2) of
// cells when broken on runs of 2+ spaces - i.e. consistent column gaps.
function detectTable(lines) {
  if (lines.length < 2) return null;
  const rows = lines.map((l) => l.trim().split(/\s{2,}/).map((c) => c.trim()));
  const colCount = rows[0].length;
  if (colCount < 2) return null;
  if (!rows.every((r) => r.length === colCount)) return null;
  return rows;
}

function headingLevel(rawLine) {
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
  const items = [];
  let current = null;
  for (const line of lines) {
    const bulletMatch = line.match(BULLET_RE);
    const numberedMatch = line.match(NUMBERED_RE);
    if (bulletMatch) {
      current = { type: "bullet", level: indentLevel(bulletMatch[1]), text: bulletMatch[3].trim() };
      items.push(current);
    } else if (numberedMatch) {
      current = { type: "numbered", level: indentLevel(numberedMatch[1]), text: numberedMatch[3].trim(), listId };
      items.push(current);
    } else if (current) {
      current.text += ` ${line.trim()}`;
    } else {
      items.push({ type: "paragraph", text: line.trim() });
    }
  }
  return items;
}

function indentLevel(indentWhitespace) {
  return Math.min(Math.floor(indentWhitespace.length / 2), 3);
}

module.exports = { parseDocument };
