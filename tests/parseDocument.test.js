"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseDocument, _internal } = require("../scripts/pdf-to-docx/parseDocument");
const { parseImageList, dropRepeatedImages } = require("../scripts/pdf-to-docx/extractImages");
const { parseHtmlXml, parseBboxLayout } = require("../scripts/pdf-to-docx/layoutInfo");

const { calloutMatch, detectTable, headingLevelFromText } = _internal;

// ---------------------------------------------------------------------------
// callout detection
// ---------------------------------------------------------------------------

test("callout: keyword with colon matches, case-insensitive", () => {
  assert.ok(calloutMatch("WARNING: do not do this"));
  assert.ok(calloutMatch("Note: remember to save"));
  assert.equal(calloutMatch("note: lower")[1], "note");
});

test("callout: shouted keyword without colon matches", () => {
  assert.ok(calloutMatch("WARNING never commit secrets"));
  assert.ok(calloutMatch("SCREENSHOT REQUIRED capture this"));
});

test("callout: a word that merely starts with a keyword does not match", () => {
  assert.equal(calloutMatch("Notebooks are great"), null);
  assert.equal(calloutMatch("Importantly, we ship"), null);
});

// ---------------------------------------------------------------------------
// table detection
// ---------------------------------------------------------------------------

test("table: consistent multi-space columns form rows", () => {
  const lines = [
    { raw: "Name        Age        City" },
    { raw: "Alice       30         NY" },
    { raw: "Bob         25         LA" },
  ];
  const rows = detectTable(lines);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], ["Name", "Age", "City"]);
  assert.deepEqual(rows[2], ["Bob", "25", "LA"]);
});

test("table: a single column (prose) is not a table", () => {
  const lines = [{ raw: "Just a sentence here" }, { raw: "And another one" }];
  assert.equal(detectTable(lines), null);
});

test("table: ragged column counts are not a table", () => {
  const lines = [{ raw: "a    b    c" }, { raw: "d    e" }];
  assert.equal(detectTable(lines), null);
});

// ---------------------------------------------------------------------------
// text-only heading heuristics
// ---------------------------------------------------------------------------

test("heading (text mode): ALL CAPS short line is H1", () => {
  assert.equal(headingLevelFromText("INSTALLATION"), 1);
});

test("heading (text mode): numbered section is H2", () => {
  assert.equal(headingLevelFromText("2.1 Prerequisites"), 2);
});

test("heading (text mode): a sentence is not a heading", () => {
  assert.equal(headingLevelFromText("This is a normal sentence that ends with a period."), null);
});

// ---------------------------------------------------------------------------
// pdfimages -list parsing
// ---------------------------------------------------------------------------

test("parseImageList: reads page and type columns, skips header", () => {
  const out = [
    "page   num  type   width height color comp bpc  enc interp  object ID",
    "--------------------------------------------------------------------",
    "   1     0  image     400   250  rgb     3   8  image  no        12  0",
    "   3     1  smask     400   250  gray    1   8  image  no        15  0",
  ].join("\n");
  const rows = parseImageList(out);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { page: 1, type: "image" });
  assert.equal(rows[1].type, "smask");
});

// ---------------------------------------------------------------------------
// numbering independence (the bug found in manual testing)
// ---------------------------------------------------------------------------

test("two separate numbered lists get distinct listIds and each restarts", () => {
  const page = ["1. First item", "2. Second item", "", "Some paragraph in between.", "", "1. Fresh list", "2. Second"].join("\n");
  const { nodes } = parseDocument([page], [], null);
  const numbered = nodes.filter((n) => n.type === "numbered");
  assert.equal(numbered.length, 4);
  const ids = [...new Set(numbered.map((n) => n.listId))];
  assert.equal(ids.length, 2, "the two lists must not share a numbering instance");
});

// ---------------------------------------------------------------------------
// header/footer removal
// ---------------------------------------------------------------------------

test("markRepeatedMargins: strips repeated header and page numbers", () => {
  const bodies = ["Installation steps go here.", "Configuration details follow.", "Troubleshooting advice last."];
  const mk = (n) => `Confidential Header\n\n${bodies[n - 1]}\n\nPage ${n} of 3`;
  const pages = _internal.annotatePages([mk(1), mk(2), mk(3)], null);
  const removed = _internal.markRepeatedMargins(pages);
  assert.ok(removed >= 6, `expected >=6 removed, got ${removed}`);
  const survived = pages.flatMap((p) => p.lines.filter((l) => !l.blank && !l.removed).map((l) => l.text));
  assert.ok(survived.every((t) => !/^Page \d+ of 3$/.test(t)), "page numbers should be gone");
  assert.ok(survived.every((t) => t !== "Confidential Header"), "repeated header should be gone");
  assert.ok(survived.some((t) => /Installation steps|Configuration details|Troubleshooting advice/.test(t)), "body must survive");
});

// ---------------------------------------------------------------------------
// repeated-image (logo) dropping
// ---------------------------------------------------------------------------

test("dropRepeatedImages: keeps all when fewer than 3 pages", () => {
  const imgs = [{ page: 1 }, { page: 2 }];
  const { kept, dropped } = dropRepeatedImages(imgs, 2);
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 0);
});

// ---------------------------------------------------------------------------
// layoutInfo XML parsers
// ---------------------------------------------------------------------------

test("parseHtmlXml: reads font size, bold and mono family", () => {
  const xml = `<pdf2xml>
<page number="1">
  <fontspec id="0" size="24" family="Helvetica-Bold"/>
  <fontspec id="1" size="11" family="Helvetica"/>
  <fontspec id="2" size="20" family="Courier"/>
  <text font="0"><b>Big Heading</b></text>
  <text font="1">normal body text</text>
  <text font="2">code_line()</text>
</page>
</pdf2xml>`;
  const pages = parseHtmlXml(xml);
  assert.equal(pages.length, 1);
  const [h, body, code] = pages[0].fontLines;
  assert.equal(h.text, "Big Heading");
  assert.ok(h.bold);
  assert.ok(h.size > body.size);
  assert.ok(code.mono);
  assert.ok(!body.mono);
});

test("parseBboxLayout: reads per-line boxes", () => {
  const html = `<doc>
<page width="612" height="792">
  <line xMin="72" yMin="100" xMax="300" yMax="112"><word>Hello</word> <word>World</word></line>
</page>
</doc>`;
  const pages = parseBboxLayout(html);
  assert.equal(pages[0].height, 792);
  assert.equal(pages[0].geomLines[0].text, "Hello World");
  assert.equal(pages[0].geomLines[0].yMin, 100);
});
