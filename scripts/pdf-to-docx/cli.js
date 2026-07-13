"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { requireTools } = require("./checkDeps");
const { extractImages } = require("./extractImages");
const { extractPageTexts } = require("./extractText");
const { parseDocument } = require("./parseDocument");
const { buildDocx } = require("./buildDocx");
const { verifyDocx } = require("./verify");

const USAGE = "Usage: node scripts/pdf-to-docx.js <input.pdf> <output.docx> [--tmpdir <dir>]";

function parseArgs(argv) {
  const positional = [];
  let tmpdir = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tmpdir") {
      tmpdir = argv[++i];
      if (!tmpdir) fail("--tmpdir requires a directory argument");
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
  return { input, output, tmpdir };
}

function fail(message) {
  console.error(`Error: ${message}\n${USAGE}`);
  process.exit(1);
}

async function main() {
  const { input, output, tmpdir } = parseArgs(process.argv.slice(2));

  try {
    requireTools();
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
    const images = extractImages(inputPath, workDir);
    console.log(`  found ${images.length} embedded image(s)`);

    console.log("Extracting text and layout (pdftotext -layout)");
    const pageTexts = extractPageTexts(inputPath, workDir);
    console.log(`  found ${pageTexts.length} page(s)`);

    console.log("Parsing document structure");
    const nodes = parseDocument(pageTexts, images);

    console.log(`Assembling .docx -> ${outputPath}`);
    await buildDocx(nodes, outputPath);

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
