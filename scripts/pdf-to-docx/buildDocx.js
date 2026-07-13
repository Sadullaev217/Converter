"use strict";

const fs = require("fs");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  WidthType,
  ShadingType,
  BorderStyle,
  LevelFormat,
  AlignmentType,
} = require("docx");
const { getPngSize } = require("./pngSize");

// US Letter, 1" margins, in twentieths-of-a-point (DXA).
const PAGE_WIDTH_DXA = 12240;
const MARGIN_DXA = 1440;
const CONTENT_WIDTH_DXA = PAGE_WIDTH_DXA - MARGIN_DXA * 2; // 9360
const CONTENT_WIDTH_PX = Math.round((CONTENT_WIDTH_DXA * 96) / 1440); // 624

const HEADING_LEVELS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
};

const CALLOUT_STYLES = {
  warning: { fill: "FDECEA", border: "D93025" },
  important: { fill: "FFF4E5", border: "F29900" },
  tip: { fill: "E8F0FE", border: "1A73E8" },
  note: { fill: "E6F4EA", border: "137333" },
  screenshot: { fill: "F1F3F4", border: "5F6368" },
};

const NUMBERED_LIST_REFERENCE_PREFIX = "pdf-to-docx-numbered-list-";

function numberedListReference(listId) {
  return `${NUMBERED_LIST_REFERENCE_PREFIX}${listId || 0}`;
}

function buildNumberingLevels() {
  return [0, 1, 2, 3].map((level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.START,
    style: {
      paragraph: {
        indent: { left: 720 * (level + 1), hanging: 360 },
      },
    },
  }));
}

async function buildDocx(nodes, outputPath) {
  const children = [];
  for (const node of nodes) {
    children.push(...renderNode(node));
  }

  // Each distinct numbered-list block in the source PDF gets its own
  // numbering instance so unrelated lists each restart at "1." instead of
  // all counting up together (docx/Word continues numbering by default
  // whenever paragraphs share the same numbering reference).
  const listIds = new Set([0]);
  nodes.forEach((node) => {
    if (node.type === "numbered") listIds.add(node.listId || 0);
  });

  const doc = new Document({
    numbering: {
      config: Array.from(listIds).map((listId) => ({
        reference: numberedListReference(listId),
        levels: buildNumberingLevels(),
      })),
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH_DXA, height: 15840 },
            margin: { top: MARGIN_DXA, bottom: MARGIN_DXA, left: MARGIN_DXA, right: MARGIN_DXA },
          },
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

function renderNode(node) {
  switch (node.type) {
    case "heading":
      return [
        new Paragraph({
          heading: HEADING_LEVELS[node.level] || HeadingLevel.HEADING_3,
          pageBreakBefore: Boolean(node.pageBreakBefore),
          children: [new TextRun(node.text)],
        }),
      ];

    case "paragraph":
      return [new Paragraph({ children: [new TextRun(node.text)] })];

    case "bullet":
      return [
        new Paragraph({
          bullet: { level: node.level || 0 },
          children: [new TextRun(node.text)],
        }),
      ];

    case "numbered":
      return [
        new Paragraph({
          numbering: { reference: numberedListReference(node.listId), level: node.level || 0 },
          children: [new TextRun(node.text)],
        }),
      ];

    case "table":
      return [buildTable(node)];

    case "code":
      return buildCodeBlock(node);

    case "callout":
      return [buildCallout(node)];

    case "image":
      return buildImage(node);

    default:
      return [];
  }
}

function distributeWidths(total, count) {
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

function buildTable(node) {
  const colCount = node.rows[0].length;
  const widths = distributeWidths(CONTENT_WIDTH_DXA, colCount);

  const rows = node.rows.map(
    (cells, rowIdx) =>
      new TableRow({
        children: cells.map(
          (cellText, colIdx) =>
            new TableCell({
              width: { size: widths[colIdx], type: WidthType.DXA },
              shading:
                rowIdx === 0
                  ? { type: ShadingType.CLEAR, fill: "D9E2F3", color: "auto" }
                  : undefined,
              children: [
                new Paragraph({
                  children: [new TextRun({ text: cellText, bold: rowIdx === 0 })],
                }),
              ],
            }),
        ),
      }),
  );

  return new Table({
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: widths,
    rows,
  });
}

function buildCodeBlock(node) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: "999999" };
  const lines = node.lines.length ? node.lines : [""];
  return lines.map(
    (line, i) =>
      new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: "F2F2F2", color: "auto" },
        border: {
          top: i === 0 ? border : undefined,
          bottom: i === lines.length - 1 ? border : undefined,
          left: border,
          right: border,
        },
        spacing: { before: 0, after: 0 },
        children: [new TextRun({ text: line.length ? line : " ", font: "Consolas", size: 20 })],
      }),
  );
}

function buildCallout(node) {
  const style = CALLOUT_STYLES[node.kind] || CALLOUT_STYLES.note;
  const border = { style: BorderStyle.SINGLE, size: 6, color: style.border };
  return new Table({
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: [CONTENT_WIDTH_DXA],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, fill: style.fill, color: "auto" },
            borders: { top: border, bottom: border, left: border, right: border },
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: `${node.label}: `, bold: true }),
                  new TextRun(node.text),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function buildImage(node) {
  try {
    const data = fs.readFileSync(node.file);
    const { width, height } = getPngSize(data);
    if (!width || !height) return [];

    const targetWidth = Math.min(width, CONTENT_WIDTH_PX);
    const targetHeight = Math.round(height * (targetWidth / width));

    return [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            type: "png",
            data,
            transformation: { width: targetWidth, height: targetHeight },
          }),
        ],
      }),
    ];
  } catch (err) {
    console.warn(`Skipping image ${node.file}: ${err.message}`);
    return [];
  }
}

module.exports = { buildDocx };
