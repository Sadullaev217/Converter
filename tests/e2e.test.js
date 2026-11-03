"use strict";

// End-to-end test: run the real CLI on tests/fixtures/sample.pdf and assert
// the produced .docx is a valid Office Open XML package whose document.xml
// contains the structural elements we expect (headings, a numbered list that
// restarts, a shaded table, a code run, a callout, and an embedded image).
//
// Requires Poppler on PATH (pdfimages/pdftotext/pdftohtml). It runs with
// --no-verify, so LibreOffice is NOT needed. If Poppler is missing or the
// fixture hasn't been generated, the test is skipped rather than failed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "sample.pdf");
const CLI = path.join(ROOT, "scripts", "pdf-to-docx.js");

function popplerAvailable() {
  const finder = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? ["pdfimages"] : ["-v", "pdfimages"];
  return spawnSync(finder, args, { shell: process.platform !== "win32" }).status === 0;
}

/** Minimal ZIP reader: returns the inflated bytes of one stored/deflated entry. */
function readZipEntry(buf, wantName) {
  // Walk local file headers (PK\x03\x04). Good enough for docx written by docx-js.
  let off = 0;
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString("utf8", off + 30, off + 30 + nameLen);
    const dataStart = off + 30 + nameLen + extraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    if (name === wantName) {
      return method === 0 ? comp : zlib.inflateRawSync(comp);
    }
    off = dataStart + compSize;
  }
  return null;
}

test("CLI produces a valid docx with the expected structure", { skip: !popplerAvailable() || !fs.existsSync(FIXTURE) ? "needs Poppler + generated fixture" : false }, () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf2docx-e2e-"));
  const out = path.join(outDir, "out.docx");
  try {
    const res = spawnSync("node", [CLI, FIXTURE, out, "--no-verify"], { encoding: "utf8" });
    assert.equal(res.status, 0, `CLI failed:\n${res.stdout}\n${res.stderr}`);
    assert.ok(fs.existsSync(out), "output .docx should exist");

    const buf = fs.readFileSync(out);
    assert.equal(buf.readUInt32LE(0), 0x04034b50, "a .docx is a ZIP (PK header)");

    const xml = readZipEntry(buf, "word/document.xml").toString("utf8");

    assert.match(xml, /Acme Deployment Guide/, "title text present");
    assert.match(xml, /w:pStyle w:val="Heading1"/, "has a Heading1");
    assert.match(xml, /w:pStyle w:val="Heading2"/, "has a Heading2");
    assert.match(xml, /2\. Installation/, "section heading text present");
    assert.match(xml, /w:numId/, "has numbered-list references");
    assert.match(xml, /docker compose up/, "code block content present");
    assert.match(xml, /SCREENSHOT REQUIRED/, "callout content present");
    assert.match(xml, /<w:tbl>/, "has a table");
    assert.match(xml, /w:shd[^>]*w:fill="/, "has shading (table/callout/code)");

    // numbering independence: more than one distinct numId in document.xml
    const numIds = new Set([...xml.matchAll(/w:numId w:val="(\d+)"/g)].map((m) => m[1]));
    assert.ok(numIds.size >= 2, `expected >= 2 numbering instances, got ${numIds.size}`);

    // the embedded screenshot should be packed as a media part
    assert.ok(readZipEntry(buf, "word/media/image1.png") || /<w:drawing>|<pic:pic/.test(xml), "image embedded");
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
