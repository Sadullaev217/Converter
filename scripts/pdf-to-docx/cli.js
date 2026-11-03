"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { requireTools } = require("./checkDeps");
const { extractImages, dropRepeatedImages } = require("./extractImages");
const { extractPageTexts } = require("./extractText");
const { extractLayoutInfo } = require("./layoutInfo");
const { parseDocument } = require("./parseDocument");
const { buildDocx } = require("./buildDocx");
const { verifyDocx } = require("./verify");

const USAGE = "Usage: node scripts/pdf-to-docx.js <input.pdf> <output.docx> [--tmpdir <dir>] [--no-verify]";

function parseArgs(argv) {
  const positional = [];
  let tmpdir = null;
  let verify = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tmpdir") {
      tmpdir = argv[++i];
      if (!tmpdir) fail("--tmpdir requires a directory argument");
    } else if (arg === "--no-verify") {
      verify = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("--")) {
      fail(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) fail("Expected an input PDF and an output .docx path");
  const [input, output] = positional;
  return { input, output, tmpdir, verify };
}

function fail(message) {
  console.error(`Error: ${message}\n${USAGE}`);
  process.exit(1);
}

async function main() {
  const { input, output, tmpdir, verify } = parseArgs(process.argv.slice(2));

  try {
    requireTools({ verify });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const inputPath = path.resolve(input);
  const outputPath = path.resolve(output);

  if (!fs.existsSync(inputPath)) fail(`Input file not found: ${inputPath}`);
  if (path.extname(inputPath).toLowerCase() !== ".pdf") fail(`Input must be a .pdf file: ${inputPath}`);
  if (path.extname(outputPath).toLowerCase() !== ".docx") fail(`Output must be a .docx file: ${outputPath}`);

  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  const tmpBase = tmpdir ? path.resolve(tmpdir) : os.tmpdir();
  fs.mkdirSync(tmpBase, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(tmpBase, "pdf-to-docx-"));

  try {
    console.log(`Extracting images (pdfimages) -> ${workDir}`);
    let images = extractImages(inputPath, workDir);
    console.log(`  found ${images.length} embedded image(s)`);

    console.log("Extracting text and layout (pdftotext -layout)");
    const pageTexts = extractPageTexts(inputPath, workDir);
    console.log(`  found ${pageTexts.length} page(s)`);

    // Drop logos repeated in a running header/footer.
    const { kept, dropped } = dropRepeatedImages(images, pageTexts.length);
    if (dropped.length) {
      dropped.forEach((img) => fs.rmSync(img.file, { force: true }));
      console.log(`  dropped ${dropped.length} repeated header/footer image(s)`);
    }
    images = kept;

    console.log("Reading font and geometry data (pdftohtml -xml, pdftotext -bbox-layout)");
    const layoutInfo = extractLayoutInfo(inputPath, workDir);
    layoutInfo.warnings.forEach((w) => console.log(`  note: ${w}`));

    const textChars = pageTexts.join("").replace(/\s/g, "").length;
    if (textChars < 10 && images.length > 0) {
      console.log(
        "  WARNING: this PDF has almost no extractable text - it looks scanned. " +
          "The output will contain the page images but no editable text (OCR is not built in).",
      );
    }

    console.log("Parsing document structure");
    const { nodes, stats } = parseDocument(pageTexts, images, layoutInfo);
    console.log(
      `  ${nodes.length} block(s); headings via ${stats.usedFonts ? "font sizes" : "text heuristics"}` +
        (stats.removedLines ? `; removed ${stats.removedLines} header/footer line(s)` : ""),
    );

    console.log(`Assembling .docx -> ${outputPath}`);
    await buildDocx(nodes, outputPath);

    if (!verify) {
      // Nothing worth keeping without verification images.
      fs.rmSync(workDir, { recursive: true, force: true });
      console.log(`Done: ${outputPath} (verification skipped)`);
      return;
    }

    console.log("Verifying output (soffice + pdftoppm)");
    const checkImages = verifyDocx(outputPath, workDir);

    // Clean up the raw extraction intermediates (source images, layout
    // text) - but keep the rendered check images around, since the whole
    // point of the verify step is letting a human look at them.
    images.forEach((img) => fs.rmSync(img.file, { force: true }));
    fs.rmSync(path.join(workDir, "text.txt"), { force: true });

    console.log("Rendered verification images for visual review:");
    checkImages.forEach((p) => console.log(`  ${p}`));
    console.log(`(kept for review in ${workDir}; delete manually once you've checked them)`);
    console.log(`Done: ${outputPath}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.error(`Temp files left for debugging at: ${workDir}`);
    process.exit(1);
  }
}

main();
